# Pinned DeepSeek-V4.1 Flash 1017 tokenizer

The historical path `deepseek-v4-tokenizer.json` contains the unmodified official 1017 tokenizer. The asset and public prompt recipe come from the same upstream revision.

- Model revision `1bae0e1088993b9b82de08f59de5be5a34e42170`
- [Official tokenizer](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/resolve/1bae0e1088993b9b82de08f59de5be5a34e42170/tokenizer.json), SHA-256 `c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b`
- [Official encoding reference](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/blob/1bae0e1088993b9b82de08f59de5be5a34e42170/encoding/encoding.py), SHA-256 `13231c592e958fb39e2af6001dae69d90e7a36b265702b9b390236fb387599e2`
- [MIT license](deepseek-v4.1-1017.LICENSE)

The shared planner tokenizes the public chat prompt and accounts for the documented maximum of 1,024 tokens per image. It separately records the HTTP body byte count and a conservative hosted framing allowance. The hosted API's returned usage is authoritative. [DeepSeek token usage](https://api-docs.deepseek.com/quick_start/token_usage/) · [DeepSeek vision limits](https://api-docs.deepseek.com/guides/vision/)
