# Local model setup

The encoder now loads a local sentence-transformers model before falling back to TF-IDF.

## Default local model path

Place a compatible sentence-transformers model in:

`models/paraphrase-multilingual-MiniLM-L12-v2/`

That folder should contain the usual Hugging Face / sentence-transformers files such as:
- `config.json`
- `modules.json`
- tokenizer files
- model weight files

## Current behavior

- If the local model folder exists and can be loaded, the demo uses `sentence-transformers`
- If the folder is missing or invalid, the demo falls back to TF-IDF automatically
- The chosen backend is written to `memory_network_output.json`

## Verify

Run:

`python main.py`

Then inspect `memory_network_output.json`:
- `metadata.encoder == "sentence-transformers"` means the local model loaded successfully
- `metadata.encoder == "tfidf"` means fallback mode is active
