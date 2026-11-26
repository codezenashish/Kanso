import { findMatches, type SearchOptions, type SearchRun } from './search-matches';

self.onmessage = ({ data }: MessageEvent<{ runs: SearchRun[]; options: SearchOptions }>) => {
  self.postMessage(findMatches(data.runs, data.options));
};
