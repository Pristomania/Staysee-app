# GPTs source files (original docx)

Place the five original GPTs `.docx` files here with **exact** names:

| File | Snapshot output |
|------|-----------------|
| `Промт.docx` | `../01-promt.md` |
| `Инструкция общения.docx` | `../02-instrukciya-obshcheniya.md` |
| `Руководство для GPTs.docx` | `../03-rukovodstvo-gpts.md` |
| `Унак Методология Стэйси.docx` | `../04-unac-metodologiya.md` |
| `Протокол организации сессий.docx` | `../05-protokol-sessij.md` |

Then run from repo root:

```bash
node scripts/extract-gpts-source-docx.mjs
```

Extraction is mechanical (docx XML → markdown paragraphs). No editorial normalization.
