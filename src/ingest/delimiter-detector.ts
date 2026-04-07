const CANDIDATES = [',', '\t', ';'] as const;
type Delim = typeof CANDIDATES[number];

function variance(nums: number[]): number {
  if (!nums.length) return Infinity;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  return nums.reduce((s, n) => s + (n - mean) ** 2, 0) / nums.length;
}

export function detectDelimiter(sample: string): Delim {
  const rawLines = sample.split('\n').slice(0, 5);
  const lines = rawLines
    .filter((line, index) => {
      if (!line.trim()) return false;
      const isLastSampledLine = index === rawLines.length - 1;
      const sampleEndsMidLine = !sample.endsWith('\n') && !sample.endsWith('\r\n');
      return !(isLastSampledLine && sampleEndsMidLine);
    });
  if (!lines.length) return ',';

  let best: Delim = ',';
  let bestVar = Infinity;

  for (const d of CANDIDATES) {
    const counts = lines.map(l => l.split(d).length);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    if (mean <= 1) continue;
    const v = variance(counts);
    if (v < bestVar) { bestVar = v; best = d; }
  }
  return best;
}
