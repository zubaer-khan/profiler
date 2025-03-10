/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow
import { createSelector } from 'reselect';
import memoize from 'memoize-immutable';
import MixedTupleMap from 'mixedtuplemap';
import * as React from 'react';
import { Localized } from '@fluent/react';

import * as Transforms from '../../profile-logic/transforms';
import * as UrlState from '../url-state';
import * as ProfileData from '../../profile-logic/profile-data';
import * as CallTree from '../../profile-logic/call-tree';
import * as ProfileSelectors from '../profile';
import * as JsTracer from '../../profile-logic/js-tracer';
import * as Cpu from '../../profile-logic/cpu';
import {
  assertExhaustiveCheck,
  ensureExists,
  getFirstItemFromSet,
} from '../../utils/flow';

import type {
  Thread,
  ThreadIndex,
  JsTracerTable,
  SamplesTable,
  NativeAllocationsTable,
  JsAllocationsTable,
  SamplesLikeTable,
  Selector,
  ThreadViewOptions,
  TransformStack,
  JsTracerTiming,
  $ReturnType,
  StartEndRange,
  WeightType,
  EventDelayInfo,
  ThreadsKey,
  CallTreeSummaryStrategy,
} from 'firefox-profiler/types';

import type { UniqueStringArray } from '../../utils/unique-string-array';
import type { TransformLabeL10nIds } from 'firefox-profiler/profile-logic/transforms';
import type { MarkerSelectorsPerThread } from './markers';

import { mergeThreads } from '../../profile-logic/merge-compare';
import { defaultThreadViewOptions } from '../../reducers/profile-view';

/**
 * Infer the return type from the getBasicThreadSelectorsPerThread and
 * getThreadSelectorsWithMarkersPerThread functions. This is done that so that
 * the local type definition with `Selector<T>` is the canonical definition for
 * the type of the selector.
 */
export type BasicThreadSelectorsPerThread = $ReturnType<
  typeof getBasicThreadSelectorsPerThread
>;
export type ThreadSelectorsPerThread = {|
  ...BasicThreadSelectorsPerThread,
  ...$ReturnType<typeof getThreadSelectorsWithMarkersPerThread>,
|};

/**
 * Create the selectors for a thread that have to do with an entire thread. This includes
 * the general filtering pipeline for threads.
 */
export function getBasicThreadSelectorsPerThread(
  threadIndexes: Set<ThreadIndex>,
  threadsKey: ThreadsKey
) {
  const getMergedThread: Selector<Thread> = createSelector(
    ProfileSelectors.getProfile,
    (profile) =>
      mergeThreads(
        [...threadIndexes].map((threadIndex) => profile.threads[threadIndex])
      )
  );
  /**
   * Either return the raw thread from the profile, or merge several raw threads
   * together.
   */
  const getThread: Selector<Thread> = (state) =>
    threadIndexes.size === 1
      ? ProfileSelectors.getProfile(state).threads[
          ensureExists(getFirstItemFromSet(threadIndexes))
        ]
      : getMergedThread(state);
  const getStringTable: Selector<UniqueStringArray> = (state) =>
    getThread(state).stringTable;
  const getSamplesTable: Selector<SamplesTable> = (state) =>
    getThread(state).samples;
  const getNativeAllocations: Selector<NativeAllocationsTable | void> = (
    state
  ) => getThread(state).nativeAllocations;
  const getJsAllocations: Selector<JsAllocationsTable | void> = (state) =>
    getThread(state).jsAllocations;
  const getThreadRange: Selector<StartEndRange> = (state) =>
    // This function is already memoized in profile-data.js, so we don't need to
    // memoize it here with `createSelector`.
    ProfileData.getTimeRangeForThread(
      getThread(state),
      ProfileSelectors.getProfileInterval(state)
    );

  /**
   * This selector gets the weight type from the thread.samples table, but
   * does not get it for others like the Native Allocations table. The call
   * tree uses the getWeightTypeForCallTree selector.
   */
  const getSamplesWeightType: Selector<WeightType> = (state) =>
    getSamplesTable(state).weightType || 'samples';

  /**
   * The first per-thread selectors filter out and transform a thread based on user's
   * interactions. The transforms are order dependendent.
   *
   * 1. Unfiltered getThread - The first selector gets the unmodified original thread.
   * 2. CPU - New samples table with processed threadCPUDelta values.
   * 3. Tab - New samples table with only samples that belongs to the active tab.
   * 4. Range - New samples table with only samples in the committed range.
   * 5. Transform - Apply the transform stack that modifies the stacks and samples.
   * 6. Implementation - Modify stacks and samples to only show a single implementation.
   * 7. Search - Exclude samples that don't include some text in the stack.
   * 8. Preview - Only include samples that are within a user's preview range selection.
   */

  const getCPUProcessedThread: Selector<Thread> = createSelector(
    getThread,
    ProfileSelectors.getSampleUnits,
    ProfileSelectors.getProfileInterval,
    (thread, sampleUnits, profileInterval) =>
      thread.samples === null ||
      thread.samples.threadCPUDelta === undefined ||
      !sampleUnits
        ? thread
        : Cpu.processThreadCPUDelta(thread, sampleUnits, profileInterval)
  );

  const getTabFilteredThread: Selector<Thread> = createSelector(
    getCPUProcessedThread,
    ProfileSelectors.getRelevantInnerWindowIDsForCurrentTab,
    (thread, relevantPages) => {
      if (relevantPages.size === 0) {
        // If this set doesn't have any relevant page, just return the whole thread.
        return thread;
      }
      return ProfileData.filterThreadByTab(thread, relevantPages);
    }
  );

  /**
   * Similar to getTabFilteredThread, but this selector returns the active tab
   * filtered thread even though we are not in the active tab view at the moment.
   * This selector is needed to make the hidden track calculations during profile
   * load time(during viewProfile).
   */
  const getActiveTabFilteredThread: Selector<Thread> = createSelector(
    getCPUProcessedThread,
    ProfileSelectors.getRelevantInnerWindowIDsForActiveTab,
    (thread, relevantPages) => {
      if (relevantPages.size === 0) {
        // If this set doesn't have any relevant page, just return the whole thread.
        return thread;
      }
      return ProfileData.filterThreadByTab(thread, relevantPages);
    }
  );

  const getRangeFilteredThread: Selector<Thread> = createSelector(
    getTabFilteredThread,
    ProfileSelectors.getCommittedRange,
    (thread, range) => {
      const { start, end } = range;
      return ProfileData.filterThreadSamplesToRange(thread, start, end);
    }
  );

  /**
   * The CallTreeSummaryStrategy determines how the call tree summarizes the
   * the current thread. By default, this is done by timing, but other
   * methods are also available. This selectors also ensures that the current
   * thread supports the last selected call tree summary strategy.
   */
  const getCallTreeSummaryStrategy: Selector<CallTreeSummaryStrategy> =
    createSelector(
      getThread,
      UrlState.getLastSelectedCallTreeSummaryStrategy,
      (thread, lastSelectedCallTreeSummaryStrategy) => {
        switch (lastSelectedCallTreeSummaryStrategy) {
          case 'timing':
            if (
              thread.samples.length === 0 &&
              thread.nativeAllocations &&
              thread.nativeAllocations.length > 0
            ) {
              // This is a profile with no samples, but with native allocations available.
              return 'native-allocations';
            }
            break;
          case 'js-allocations':
            if (!thread.jsAllocations) {
              // Attempting to view a thread with no JS allocations, switch back to timing.
              return 'timing';
            }
            break;
          case 'native-allocations':
          case 'native-retained-allocations':
          case 'native-deallocations-sites':
          case 'native-deallocations-memory':
            if (!thread.nativeAllocations) {
              // Attempting to view a thread with no native allocations, switch back
              // to timing.
              return 'timing';
            }
            break;
          default:
            assertExhaustiveCheck(
              lastSelectedCallTreeSummaryStrategy,
              'Unhandled call tree sumary strategy.'
            );
        }
        return lastSelectedCallTreeSummaryStrategy;
      }
    );

  const getUnfilteredSamplesForCallTree: Selector<SamplesLikeTable> =
    createSelector(
      getThread,
      getCallTreeSummaryStrategy,
      CallTree.extractSamplesLikeTable
    );

  /**
   * This selector returns the offset to add to a sampleIndex when accessing the
   * base thread, if your thread is a range filtered thread (all but the base
   * `getThread` or the last `getPreviewFilteredThread`).
   */
  const getSampleIndexOffsetFromCommittedRange: Selector<number> =
    createSelector(
      getUnfilteredSamplesForCallTree,
      ProfileSelectors.getCommittedRange,
      (samples, { start, end }) => {
        const [beginSampleIndex] = ProfileData.getSampleIndexRangeForSelection(
          samples,
          start,
          end
        );
        return beginSampleIndex;
      }
    );

  const getFriendlyThreadName: Selector<string> = createSelector(
    ProfileSelectors.getThreads,
    getThread,
    ProfileData.getFriendlyThreadName
  );

  const getThreadProcessDetails: Selector<string> = createSelector(
    getThread,
    getFriendlyThreadName,
    ProfileData.getThreadProcessDetails
  );

  const getViewOptions: Selector<ThreadViewOptions> = (state) =>
    ProfileSelectors.getProfileViewOptions(state).perThread[threadsKey] ||
    defaultThreadViewOptions;

  const getHasUsefulTimingSamples: Selector<boolean> = createSelector(
    getSamplesTable,
    getThread,
    ProfileData.hasUsefulSamples
  );

  const getHasUsefulJsAllocations: Selector<boolean> = createSelector(
    getJsAllocations,
    getThread,
    ProfileData.hasUsefulSamples
  );

  const getHasUsefulNativeAllocations: Selector<boolean> = createSelector(
    getNativeAllocations,
    getThread,
    ProfileData.hasUsefulSamples
  );

  /**
   * We can only compute the retained memory in the versions of the native allocations
   * format that provide the memory address. The earlier versions did not have
   * balanced allocations and deallocations.
   */
  const getCanShowRetainedMemory: Selector<boolean> = (state) => {
    const nativeAllocations = getNativeAllocations(state);
    if (!nativeAllocations) {
      return false;
    }
    return 'memoryAddress' in nativeAllocations;
  };

  /**
   * The JS tracer selectors are placed in the thread selectors since there are
   * not many of them. If this section grows, then consider breaking them out
   * into their own file.
   */
  const getJsTracerTable: Selector<JsTracerTable | null> = (state) =>
    getThread(state).jsTracer || null;

  /**
   * This selector can be very slow, so care should be taken when running it to provide
   * a helpful loading message for the user. Provide separate selectors for the stack
   * based timing, and the leaf timing, so that they memoize nicely.
   */
  const getExpensiveJsTracerTiming: Selector<JsTracerTiming[] | null> =
    createSelector(getJsTracerTable, getThread, (jsTracerTable, thread) =>
      jsTracerTable === null
        ? null
        : JsTracer.getJsTracerTiming(jsTracerTable, thread)
    );

  /**
   * This selector can be very slow, so care should be taken when running it to provide
   * a helpful loading message for the user. Provide separate selectors for the stack
   * based timing, and the leaf timing, so that they memoize nicely.
   */
  const getExpensiveJsTracerLeafTiming: Selector<JsTracerTiming[] | null> =
    createSelector(
      getJsTracerTable,
      getStringTable,
      (jsTracerTable, stringTable) =>
        jsTracerTable === null
          ? null
          : JsTracer.getJsTracerLeafTiming(jsTracerTable, stringTable)
    );

  const getProcessedEventDelaysOrNull: Selector<EventDelayInfo | null> =
    createSelector(
      getSamplesTable,
      ProfileSelectors.getProfileInterval,
      (samplesTable, interval) =>
        samplesTable === null || samplesTable.eventDelay === undefined
          ? null
          : ProfileData.processEventDelays(samplesTable, interval)
    );

  const getProcessedEventDelays: Selector<EventDelayInfo> = (state) =>
    ensureExists(
      getProcessedEventDelaysOrNull(state),
      'Could not get the processed event delays'
    );

  return {
    getThread,
    getStringTable,
    getSamplesTable,
    getSamplesWeightType,
    getNativeAllocations,
    getJsAllocations,
    getThreadRange,
    getRangeFilteredThread,
    getUnfilteredSamplesForCallTree,
    getSampleIndexOffsetFromCommittedRange,
    getFriendlyThreadName,
    getThreadProcessDetails,
    getViewOptions,
    getJsTracerTable,
    getExpensiveJsTracerTiming,
    getExpensiveJsTracerLeafTiming,
    getHasUsefulTimingSamples,
    getHasUsefulJsAllocations,
    getHasUsefulNativeAllocations,
    getCanShowRetainedMemory,
    getCPUProcessedThread,
    getTabFilteredThread,
    getActiveTabFilteredThread,
    getProcessedEventDelays,
    getCallTreeSummaryStrategy,
  };
}

type BasicThreadAndMarkerSelectorsPerThread = {|
  ...BasicThreadSelectorsPerThread,
  ...MarkerSelectorsPerThread,
|};

export function getThreadSelectorsWithMarkersPerThread(
  threadSelectors: BasicThreadAndMarkerSelectorsPerThread,
  threadIndexes: Set<ThreadIndex>,
  threadsKey: ThreadsKey
) {
  // It becomes very expensive to apply each transform over and over again as they
  // typically take around 100ms to run per transform on a fast machine. Memoize
  // memoize each step individually so that they transform stack can be pushed and
  // popped frequently and easily.
  const _applyTransformMemoized = memoize(Transforms.applyTransform, {
    cache: new MixedTupleMap(),
  });

  const getTransformStack: Selector<TransformStack> = (state) =>
    UrlState.getTransformStack(state, threadsKey);

  const getRangeAndTransformFilteredThread: Selector<Thread> = createSelector(
    threadSelectors.getRangeFilteredThread,
    getTransformStack,
    ProfileSelectors.getDefaultCategory,
    threadSelectors.getMarkerGetter,
    threadSelectors.getFullMarkerListIndexes,
    ProfileSelectors.getMarkerSchemaByName,
    ProfileSelectors.getCategories,
    (
      startingThread,
      transforms,
      defaultCategory,
      markerGetter,
      markerIndexes,
      markerSchemaByName,
      categories
    ) => {
      return transforms.reduce(
        // Apply the reducer using an arrow function to ensure correct memoization.
        (thread, transform) =>
          _applyTransformMemoized(
            thread,
            transform,
            defaultCategory,
            markerGetter,
            markerIndexes,
            markerSchemaByName,
            categories
          ),
        startingThread
      );
    }
  );

  const _getImplementationFilteredThread: Selector<Thread> = createSelector(
    getRangeAndTransformFilteredThread,
    UrlState.getImplementationFilter,
    ProfileSelectors.getDefaultCategory,
    ProfileData.filterThreadByImplementation
  );

  const _getImplementationAndSearchFilteredThread: Selector<Thread> =
    createSelector(
      _getImplementationFilteredThread,
      UrlState.getSearchStrings,
      (thread, searchStrings) => {
        return ProfileData.filterThreadToSearchStrings(thread, searchStrings);
      }
    );

  const getFilteredThread: Selector<Thread> = createSelector(
    _getImplementationAndSearchFilteredThread,
    UrlState.getInvertCallstack,
    ProfileSelectors.getDefaultCategory,
    (thread, shouldInvertCallstack, defaultCategory) => {
      return shouldInvertCallstack
        ? ProfileData.invertCallstack(thread, defaultCategory)
        : thread;
    }
  );

  const getPreviewFilteredThread: Selector<Thread> = createSelector(
    getFilteredThread,
    ProfileSelectors.getPreviewSelection,
    (thread, previewSelection): Thread => {
      if (!previewSelection.hasSelection) {
        return thread;
      }
      const { selectionStart, selectionEnd } = previewSelection;
      return ProfileData.filterThreadSamplesToRange(
        thread,
        selectionStart,
        selectionEnd
      );
    }
  );

  const getFilteredSamplesForCallTree: Selector<SamplesLikeTable> =
    createSelector(
      getFilteredThread,
      threadSelectors.getCallTreeSummaryStrategy,
      CallTree.extractSamplesLikeTable
    );

  const getPreviewFilteredSamplesForCallTree: Selector<SamplesLikeTable> =
    createSelector(
      getPreviewFilteredThread,
      threadSelectors.getCallTreeSummaryStrategy,
      CallTree.extractSamplesLikeTable
    );

  /**
   * This selector returns the offset to add to a sampleIndex when accessing the
   * base thread, if your thread is the preview filtered thread.
   */
  const getSampleIndexOffsetFromPreviewRange: Selector<number> = createSelector(
    getFilteredSamplesForCallTree,
    ProfileSelectors.getPreviewSelection,
    threadSelectors.getSampleIndexOffsetFromCommittedRange,
    (samples, previewSelection, sampleIndexFromCommittedRange) => {
      if (!previewSelection.hasSelection) {
        return sampleIndexFromCommittedRange;
      }

      const [beginSampleIndex] = ProfileData.getSampleIndexRangeForSelection(
        samples,
        previewSelection.selectionStart,
        previewSelection.selectionEnd
      );

      return sampleIndexFromCommittedRange + beginSampleIndex;
    }
  );

  const getTransformLabelL10nIds: Selector<TransformLabeL10nIds[]> =
    createSelector(
      ProfileSelectors.getMeta,
      getRangeAndTransformFilteredThread,
      threadSelectors.getFriendlyThreadName,
      getTransformStack,
      Transforms.getTransformLabelL10nIds
    );

  const getLocalizedTransformLabels: Selector<React.Node[]> = createSelector(
    getTransformLabelL10nIds,
    (transformL10nIds) =>
      transformL10nIds.map((transform) => (
        <Localized
          id={transform.l10nId}
          vars={{ item: transform.item }}
          key={transform.item}
        ></Localized>
      ))
  );

  return {
    getTransformStack,
    getRangeAndTransformFilteredThread,
    getFilteredThread,
    getPreviewFilteredThread,
    getFilteredSamplesForCallTree,
    getPreviewFilteredSamplesForCallTree,
    getSampleIndexOffsetFromPreviewRange,
    getTransformLabelL10nIds,
    getLocalizedTransformLabels,
  };
}
