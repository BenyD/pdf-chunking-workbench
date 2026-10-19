#!/usr/bin/env bash
# Removes everything setup.sh created, in the reverse order. Safe to run twice. Afterwards it lists anything
# still tagged project=chunklab-bedrock in ap-south-1, which should be nothing.
set -uo pipefail
R=ap-south-1
ACCT=$(aws sts get-caller-identity --query Account --output text)
SRC=chunklab-bedrock-src-$ACCT; VEC=chunklab-bedrock-vectors-$ACCT; INDEX=hierarchical
ROLE=chunklab-bedrock-kb-role; APPUSER=chunklab-bedrock-app

echo "== Website user and its access keys"
for k in $(aws iam list-access-keys --user-name $APPUSER --query 'AccessKeyMetadata[].AccessKeyId' --output text 2>/dev/null); do
  aws iam delete-access-key --user-name $APPUSER --access-key-id "$k"; done
aws iam delete-user-policy --user-name $APPUSER --policy-name retrieve-only 2>/dev/null
aws iam delete-user --user-name $APPUSER 2>/dev/null && echo "deleted user $APPUSER"

echo "== Knowledge base and its data source"
for KB in $(aws bedrock-agent list-knowledge-bases --region $R --query "knowledgeBaseSummaries[?name=='chunklab-hierarchical'].knowledgeBaseId" --output text); do
  for DS in $(aws bedrock-agent list-data-sources --region $R --knowledge-base-id "$KB" --query 'dataSourceSummaries[].dataSourceId' --output text); do
    aws bedrock-agent delete-data-source --region $R --knowledge-base-id "$KB" --data-source-id "$DS" >/dev/null && echo "deleted data source $DS"; done
  sleep 10
  aws bedrock-agent delete-knowledge-base --region $R --knowledge-base-id "$KB" >/dev/null && echo "deleted knowledge base $KB"
done

echo "== S3 Vectors index and bucket"
aws s3vectors delete-index --vector-bucket-name "$VEC" --index-name $INDEX --region $R 2>/dev/null && echo "deleted index"
aws s3vectors delete-vector-bucket --vector-bucket-name "$VEC" --region $R 2>/dev/null && echo "deleted vector bucket"

echo "== S3 bucket with the PDFs"
aws s3 rb "s3://$SRC" --force --region $R 2>/dev/null && echo "deleted bucket $SRC"

echo "== IAM role"
aws iam delete-role-policy --role-name $ROLE --policy-name kb-access 2>/dev/null
aws iam delete-role --role-name $ROLE 2>/dev/null && echo "deleted role $ROLE"

rm -f "$(dirname "$0")/state.env"
echo "== Anything left with the tag:"
aws resourcegroupstaggingapi get-resources --region $R --tag-filters Key=project,Values=chunklab-bedrock --query 'ResourceTagMappingList[].ResourceARN' --output text
aws iam get-role --role-name $ROLE >/dev/null 2>&1 && echo "role still there"; aws iam get-user --user-name $APPUSER >/dev/null 2>&1 && echo "user still there"
echo "== Website settings in Vercel"
cd "$(dirname "$0")/../../web" && for v in NEXT_PUBLIC_BEDROCK AWS_BEDROCK_ACCESS_KEY_ID AWS_BEDROCK_SECRET_ACCESS_KEY AWS_BEDROCK_KB_ID AWS_BEDROCK_REGION; do
  vercel env rm "$v" production --yes >/dev/null 2>&1 && echo "removed $v"; done
echo "Now deploy the website again (cd web && vercel deploy --prod) so the Bedrock option disappears."
