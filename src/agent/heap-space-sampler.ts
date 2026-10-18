/// <reference types="node" />
import v8 from 'node:v8';
import { truncToNonNegativeInt } from './int.js';

/** One V8 heap space, all sizes integer bytes (V8's field names kept as reported). */
export type HeapSpaceEntry = {
  name: string;
  space_size: number;
  space_used_size: number;
  space_available_size: number;
  physical_space_size: number;
};

/** Named heap spaces in V8's order. */
export type HeapSpaceSample = HeapSpaceEntry[];

export function sampleHeapSpaces(): HeapSpaceSample {
  return v8.getHeapSpaceStatistics().map((space) => ({
    name: space.space_name,
    space_size: truncToNonNegativeInt(space.space_size),
    space_used_size: truncToNonNegativeInt(space.space_used_size),
    space_available_size: truncToNonNegativeInt(space.space_available_size),
    physical_space_size: truncToNonNegativeInt(space.physical_space_size),
  }));
}
