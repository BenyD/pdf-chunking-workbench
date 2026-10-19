# Amazon Bedrock hierarchical chunking (comparison)

A real Amazon Bedrock knowledge base using Bedrock's own hierarchical chunking, so its results can be measured
on the same 129 questions as ours and shown in the app as an option. It is a comparison, not part of the
default app, and it costs money while it exists (very little; see below).

Everything lives in **ap-south-1 (Mumbai)**, in the account the AWS CLI is signed in to, and is tagged
`project=chunklab-bedrock`.

## What gets created

| What | Name | Why |
|---|---|---|
| S3 bucket | `chunklab-bedrock-src-<account>` | the 14 benchmark PDFs, plus a `.metadata.json` beside each (`doc` = file name) |
| S3 Vectors bucket | `chunklab-bedrock-vectors-<account>` | the vector store: the cheapest one Bedrock supports |
| S3 Vectors index | `hierarchical` | 1024 dimensions, cosine |
| IAM role | `chunklab-bedrock-kb-role` | what the knowledge base runs as: read the PDF bucket, call Titan embeddings, write the index |
| Knowledge base | `chunklab-hierarchical` | Titan Text Embeddings V2 (1024), S3 Vectors storage |
| Data source | `pdfs` | the PDF bucket, **hierarchical chunking: 1,500-token parents, 300-token children, 60 overlap** (Bedrock's documented defaults), default parser |
| IAM user | `chunklab-bedrock-app` | what the website uses: `bedrock:Retrieve` on this knowledge base only |
| Access key for that user | in Vercel as `AWS_BEDROCK_ACCESS_KEY_ID` / `AWS_BEDROCK_SECRET_ACCESS_KEY` | never committed or printed |
| Vercel settings | `NEXT_PUBLIC_BEDROCK=1`, `AWS_BEDROCK_KB_ID`, `AWS_BEDROCK_REGION` | turn the option on in Search |

## Set up

```bash
aws login
cd worker
.venv/bin/python ../scripts/bedrock_kb.py export ../samples/work/bedrock
../deploy/bedrock/setup.sh ../samples/work/bedrock
uv run --with boto3 python ../scripts/bedrock_kb.py eval
```

Then load the PDFs as 8-page parts, one a minute (about 100 minutes for the 14 documents):

```bash
.venv/bin/python ../scripts/bedrock_kb.py parts ../samples/work/bedrock ../samples/work/bedrock-parts
aws s3 sync ../samples/work/bedrock-parts s3://chunklab-bedrock-src-<account>/ --region ap-south-1 --delete
uv run --with boto3 --with "botocore[crt]" python ../scripts/bedrock_kb.py reingest
```

Why: this account may call Titan embeddings 60 times a minute in ap-south-1. Sent whole, Bedrock reported the
ingestion COMPLETE but kept only the first pages of each long document (BNSS to page 33 of 297, Humira 13 of
100; Humira alone, 60 of 100). Parts of 8 pages, a minute apart, stay under the quota. The cost: a Bedrock
parent passage cannot run across two parts. A quota increase would let whole files go in.

`setup.sh` can be run again; it reuses what exists and re-syncs the PDFs. The ids it made are written to
`deploy/bedrock/state.env` (not committed).

## Cost

- Embedding the 14 PDFs once: about 1.5 to 2 million tokens with Titan Text Embeddings V2, cents.
- S3 Vectors and S3 storage: a few thousand vectors and 15 MB of PDFs, cents a month.
- Each search: one Titan embedding of the question and one vector query, a small fraction of a cent.
- The knowledge base itself has no charge of its own.

## Clean up (removes everything)

```bash
aws login
deploy/bedrock/cleanup.sh
cd web && vercel deploy --prod
```

`cleanup.sh` also removes the website settings from Vercel (`NEXT_PUBLIC_BEDROCK`, `AWS_BEDROCK_ACCESS_KEY_ID`,
`AWS_BEDROCK_SECRET_ACCESS_KEY`, `AWS_BEDROCK_KB_ID`, `AWS_BEDROCK_REGION`); the deploy after it takes the option
off the Search page.

`cleanup.sh` deletes, in this order: the website user's access keys, its policy and the user; the data source
and the knowledge base; the S3 Vectors index and vector bucket; the PDF bucket and every object in it; the
role's policy and the role. It can be run twice. At the end it lists anything in ap-south-1 still tagged
`project=chunklab-bedrock` and says if the role or user still exists; both should print nothing.

To check by hand afterwards, in the AWS console (region Mumbai): Bedrock > Knowledge bases, S3 > Buckets,
S3 > Vector buckets, IAM > Roles and Users (search `chunklab-bedrock`). The Bedrock option disappears from the
app once the Vercel variables are removed and the site is deployed again.
