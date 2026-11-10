/**
 * The demo's prebuilt ColBERT token index as bytes: scripts/demo-data.mjs packs the index that
 * buildColbertTokenIndex() returns, and the worker unpacks it for createColbertRetriever({ index }). The binary holds
 * each passage's token count (uint32) followed by the TurboQuant codes; the small fields (sizes, codebook, signs) go
 * into the manifest, which the worker reads first anyway. Typed arrays use the platform's byte order, little-endian
 * on every browser and CPU the demo targets, as docs/data/vectors.bin.br does.
 * Why ship codes instead of encoding in the browser: VERIFIED: encoding the 2,000 passages with WASM MoEdernColBERT
 * took 13 to 15 s in Chromium, while the codes are 7.80 MB as Brotli and need no model to load (2026-11-02, 2026-11-09).
 */

/** Splits an index into manifest fields and one binary. */
export function packTokenIndex({ tokenCounts, turboquant }) {
  const { size, dims, rotatedDims, codeBytes, clip, codebook, signs, codes } = turboquant;
  const counts = Uint32Array.from(tokenCounts);
  const bytes = new Uint8Array(counts.byteLength + codes.length);
  bytes.set(new Uint8Array(counts.buffer), 0);
  bytes.set(codes, counts.byteLength);
  return {
    meta: {
      documents: counts.length,
      size,
      dims,
      rotatedDims,
      codeBytes,
      clip,
      // float32 → JSON number → float32 restores each value exactly.
      codebook: Array.from(codebook),
      signs: Array.from(signs),
    },
    bytes,
  };
}

/** The inverse of packTokenIndex; the codes stay a view into `bytes`. */
export function unpackTokenIndex(meta, bytes) {
  const countBytes = 4 * meta.documents;
  if (bytes.length !== countBytes + meta.size * meta.codeBytes)
    throw new RangeError(
      `Token index holds ${bytes.length} bytes, expected ${countBytes + meta.size * meta.codeBytes}`,
    );
  return {
    tokenCounts: new Uint32Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + countBytes),
    ),
    turboquant: {
      size: meta.size,
      dims: meta.dims,
      rotatedDims: meta.rotatedDims,
      codeBytes: meta.codeBytes,
      clip: meta.clip,
      codebook: Float32Array.from(meta.codebook),
      signs: Int8Array.from(meta.signs),
      codes: bytes.subarray(countBytes),
    },
  };
}
