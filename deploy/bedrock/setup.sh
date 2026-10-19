#!/usr/bin/env bash
# Amazon Bedrock Knowledge Base with Bedrock's own hierarchical chunking, for comparison with ours.
# Everything is created in ap-south-1 and tagged project=chunklab-bedrock; cleanup.sh removes it all.
#   ./setup.sh <folder of PDFs>        (scripts/bedrock_kb.py export writes that folder)
set -euo pipefail
R=ap-south-1
ACCT=$(aws sts get-caller-identity --query Account --output text)
SRC=chunklab-bedrock-src-$ACCT                 # the PDFs Bedrock reads
VEC=chunklab-bedrock-vectors-$ACCT             # S3 Vectors bucket: the cheapest vector store Bedrock supports
INDEX=hierarchical
ROLE=chunklab-bedrock-kb-role                  # what the knowledge base runs as
APPUSER=chunklab-bedrock-app                   # what the website uses to search it: bedrock:Retrieve only
TAG="Key=project,Value=chunklab-bedrock"
STATE="$(dirname "$0")/state.env"
DIR=${1:?folder of PDFs}

echo "== S3 bucket for the PDFs"
aws s3api head-bucket --bucket "$SRC" 2>/dev/null || aws s3api create-bucket --bucket "$SRC" --region $R \
  --create-bucket-configuration LocationConstraint=$R >/dev/null
aws s3api put-bucket-tagging --bucket "$SRC" --tagging "TagSet=[{$TAG}]"
aws s3api put-public-access-block --bucket "$SRC" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3 sync "$DIR" "s3://$SRC/" --region $R --delete --only-show-errors

echo "== S3 Vectors bucket and index (1024 dimensions, cosine, as Titan Text Embeddings V2 gives)"
aws s3vectors get-vector-bucket --vector-bucket-name "$VEC" --region $R >/dev/null 2>&1 || \
  aws s3vectors create-vector-bucket --vector-bucket-name "$VEC" --region $R >/dev/null
aws s3vectors get-index --vector-bucket-name "$VEC" --index-name $INDEX --region $R >/dev/null 2>&1 || \
  aws s3vectors create-index --vector-bucket-name "$VEC" --index-name $INDEX --region $R \
    --data-type float32 --dimension 1024 --distance-metric cosine \
    --metadata-configuration '{"nonFilterableMetadataKeys":["AMAZON_BEDROCK_TEXT","AMAZON_BEDROCK_METADATA"]}' >/dev/null
INDEX_ARN=$(aws s3vectors get-index --vector-bucket-name "$VEC" --index-name $INDEX --region $R --query index.indexArn --output text)

echo "== IAM role for the knowledge base"
aws iam get-role --role-name $ROLE >/dev/null 2>&1 || aws iam create-role --role-name $ROLE --tags $TAG \
  --assume-role-policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"bedrock.amazonaws.com\"},\"Action\":\"sts:AssumeRole\",\"Condition\":{\"StringEquals\":{\"aws:SourceAccount\":\"$ACCT\"}}}]}" >/dev/null
aws iam put-role-policy --role-name $ROLE --policy-name kb-access --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[
  {\"Effect\":\"Allow\",\"Action\":[\"s3:GetObject\",\"s3:ListBucket\"],\"Resource\":[\"arn:aws:s3:::$SRC\",\"arn:aws:s3:::$SRC/*\"]},
  {\"Effect\":\"Allow\",\"Action\":\"bedrock:InvokeModel\",\"Resource\":\"arn:aws:bedrock:$R::foundation-model/amazon.titan-embed-text-v2:0\"},
  {\"Effect\":\"Allow\",\"Action\":[\"s3vectors:PutVectors\",\"s3vectors:GetVectors\",\"s3vectors:DeleteVectors\",\"s3vectors:QueryVectors\",\"s3vectors:GetIndex\"],\"Resource\":\"$INDEX_ARN\"}]}"
ROLE_ARN=$(aws iam get-role --role-name $ROLE --query Role.Arn --output text)
sleep 10                                                  # a new role takes a few seconds to be usable

echo "== Knowledge base"
KB=$(aws bedrock-agent list-knowledge-bases --region $R --query "knowledgeBaseSummaries[?name=='chunklab-hierarchical'].knowledgeBaseId" --output text)
if [ -z "$KB" ] || [ "$KB" = "None" ]; then
  KB=$(aws bedrock-agent create-knowledge-base --region $R --name chunklab-hierarchical --role-arn "$ROLE_ARN" \
    --tags project=chunklab-bedrock \
    --knowledge-base-configuration "{\"type\":\"VECTOR\",\"vectorKnowledgeBaseConfiguration\":{\"embeddingModelArn\":\"arn:aws:bedrock:$R::foundation-model/amazon.titan-embed-text-v2:0\",\"embeddingModelConfiguration\":{\"bedrockEmbeddingModelConfiguration\":{\"dimensions\":1024}}}}" \
    --storage-configuration "{\"type\":\"S3_VECTORS\",\"s3VectorsConfiguration\":{\"indexArn\":\"$INDEX_ARN\"}}" \
    --query knowledgeBase.knowledgeBaseId --output text)
fi
for i in $(seq 1 30); do [ "$(aws bedrock-agent get-knowledge-base --region $R --knowledge-base-id $KB --query knowledgeBase.status --output text)" = ACTIVE ] && break; sleep 5; done

echo "== Data source: Bedrock's hierarchical chunking at its documented defaults (1,500-token parents, 300-token children, 60 overlap)"
DS=$(aws bedrock-agent list-data-sources --region $R --knowledge-base-id $KB --query "dataSourceSummaries[0].dataSourceId" --output text)
if [ -z "$DS" ] || [ "$DS" = "None" ]; then
  DS=$(aws bedrock-agent create-data-source --region $R --knowledge-base-id $KB --name pdfs \
    --data-source-configuration "{\"type\":\"S3\",\"s3Configuration\":{\"bucketArn\":\"arn:aws:s3:::$SRC\"}}" \
    --vector-ingestion-configuration '{"chunkingConfiguration":{"chunkingStrategy":"HIERARCHICAL","hierarchicalChunkingConfiguration":{"levelConfigurations":[{"maxTokens":1500},{"maxTokens":300}],"overlapTokens":60}}}' \
    --query dataSource.dataSourceId --output text)
fi

echo "== Ingestion"
JOB=$(aws bedrock-agent start-ingestion-job --region $R --knowledge-base-id $KB --data-source-id $DS --query ingestionJob.ingestionJobId --output text)
for i in $(seq 1 120); do
  S=$(aws bedrock-agent get-ingestion-job --region $R --knowledge-base-id $KB --data-source-id $DS --ingestion-job-id $JOB --query ingestionJob.status --output text)
  [ "$S" = COMPLETE ] || [ "$S" = FAILED ] && break; sleep 10
done
aws bedrock-agent get-ingestion-job --region $R --knowledge-base-id $KB --data-source-id $DS --ingestion-job-id $JOB --query "ingestionJob.[status,statistics,failureReasons]" --output json

echo "== Website user: may only search this knowledge base"
aws iam get-user --user-name $APPUSER >/dev/null 2>&1 || aws iam create-user --user-name $APPUSER --tags $TAG >/dev/null
aws iam put-user-policy --user-name $APPUSER --policy-name retrieve-only --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"bedrock:Retrieve\",\"Resource\":\"arn:aws:bedrock:$R:$ACCT:knowledge-base/$KB\"}]}"

printf 'REGION=%s\nACCOUNT=%s\nSRC_BUCKET=%s\nVECTOR_BUCKET=%s\nINDEX=%s\nKB_ID=%s\nDATA_SOURCE_ID=%s\nROLE=%s\nAPP_USER=%s\n' \
  $R "$ACCT" "$SRC" "$VEC" $INDEX "$KB" "$DS" $ROLE $APPUSER > "$STATE"
echo "done; ids in $STATE"
