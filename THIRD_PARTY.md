# Third-party assets

VERIFIED: the static website vendors the defuss-shadcn 0.9.11 stylesheets and JavaScript runtime, the version defuss-lexicalsearch loads from its CDN. Serving them from `docs/assets/vendor` means the page loads no stylesheet or script from a CDN, and the e2e test needs no network for them. The fetched bytes match the SHA-384 integrity values that defuss-lexicalsearch pins. Its MIT notice is in `docs/assets/vendor/LICENSE.txt`.

| Asset | SHA-384 |
| --- | --- |
| core.min.css | `qUQCm/MM2DNkdT3uEdx8Mpocj+GwXlgLat0FnWv657c16tHWOouZFT2nV7kg5pBE` |
| all.min.css | `D6ChEYfIRnfJpWB03vSS4b4b1ZdHsnCNUwg2VBFrBkjDVHIVvdVDXaJ1M2hFAdK2` |
| shapes.min.css | `ZmqJOMYRZyhvc1zR5eOVub6RQoBcnL3oe8ubon6JcjkLJK/0Fy3THAhfLP8K3C71` |
| all.min.js | `smU3aE2UPGvVE+nQS/ekmmE86ccjq2yap/zPMBoITba6SOq71Fil6vo4HZHaFZRY` |

Source: https://github.com/kyr0/defuss-shadcn. Distribution: https://cdn.jsdelivr.net/gh/kyr0/defuss-shadcn@0.9.11/dist/.

The docs build copies defuss-lid's `major_20` language pack and its CLD3 WebAssembly core into `docs/assets/lid`, where the demo worker loads them to detect a typed question's language. The pack holds Google CLD3 weights (Apache-2.0, Copyright 2016 Google Inc.), quantized and refitted by defuss-lid (MIT); the core is the cld3-asm WebAssembly (MIT). Their notice and both licenses are copied beside them.

The docs build also copies the ONNX Runtime Web JavaScript/WASM files selected by defuss-vectorsearch. Their license and third-party notices are retained beside those files. Dependency versions and integrity hashes are locked in `bun.lock`.

Model weights are downloaded separately from their pinned upstream revisions into `.models/`; neither the package nor the repository distributes them. `output/model-assets.json` records the pinned model files and SHA-256 hashes. The website demo fetches the same pinned files from Hugging Face in the browser.

VERIFIED: the website redistributes the text of tiny-embedding-bench-v1 (SHA-256 `3d09d365…`) in `docs/data/corpus.json.gz`: 2,000 passages and 1,000 questions, unchanged and regrouped by `scripts/demo-data.mjs`, beside their recorded Winzling vectors in `docs/data/vectors.bin.gz`. The dataset is a short-passage subset of Belebele (Lucas Bandarkar et al., ACL 2024; Meta; underlying Wikimedia contributors), licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The corpus file carries the attribution, the citation and the subset's changes, and the demo shows the attribution below the benchmark. The npm package does not contain these files; its `files` list is `dist`, `README.md` and `LICENSE`. See [language evaluation](docs/languages.md) for dataset provenance. The browser recall benchmark serves the ONNX Runtime Web files directly from `node_modules`.

VERIFIED: `fixtures/api-docs-queries.mjs` quotes short anchor phrases from the defuss-shadcn documentation (MIT, commit `896cf2ac…`), so the benchmark can check each query's gold section. `bench/api-docs.mjs` downloads the pages at that commit into the gitignored `input/` and the repository does not redistribute them.

VERIFIED: the demo's 100 sample notes in `website/sample-notes.mjs` are the texts of the defuss-vectorsearch website's `docs/assets/sample-notes.js`, MIT-licensed.
