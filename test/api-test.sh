#!/bin/bash

# LLM Proxy API 测试脚本
# 测试凭证捕获、模型列表、聊天完成功能

BASE_URL="http://localhost:8080"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}======================================${NC}"
echo -e "${CYAN}   LLM Proxy API 测试${NC}"
echo -e "${CYAN}======================================${NC}"
echo ""

# 1. 测试凭证捕获
echo -e "${YELLOW}[1/3] 测试凭证状态${NC}"
echo "GET $BASE_URL/debug/credentials"
echo ""

CRED_RESPONSE=$(curl -s "$BASE_URL/debug/credentials")
HAS_CRED=$(echo "$CRED_RESPONSE" | grep -o '"hasCredentials": *[^,}]*' | cut -d: -f2 | tr -d ' ')

echo "$CRED_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$CRED_RESPONSE"
echo ""

if [ "$HAS_CRED" = "true" ]; then
    echo -e "${GREEN}✓ 凭证已捕获${NC}"
else
    echo -e "${RED}✗ 凭证未捕获 - 请先在浏览器中发送消息${NC}"
    exit 1
fi
echo ""

# 2. 测试模型列表
echo -e "${YELLOW}[2/3] 测试模型列表${NC}"
echo "GET $BASE_URL/v1/models"
echo ""

MODELS_RESPONSE=$(curl -s "$BASE_URL/v1/models")
echo "$MODELS_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$MODELS_RESPONSE"
echo ""

FIRST_MODEL=$(echo "$MODELS_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['id'] if d.get('data') else '')" 2>/dev/null)

if [ -n "$FIRST_MODEL" ]; then
    echo -e "${GREEN}✓ 获取到模型: $FIRST_MODEL${NC}"
else
    echo -e "${RED}✗ 无法获取模型列表${NC}"
    exit 1
fi
echo ""

# 3. 测试聊天完成 (非流式)
echo -e "${YELLOW}[3/3] 测试聊天完成 (模型: $FIRST_MODEL)${NC}"
echo "POST $BASE_URL/v1/chat/completions"
echo ""

REQUEST_BODY=$(cat <<EOF
{
  "model": "$FIRST_MODEL",
  "messages": [
    {"role": "user", "content": "Hello, please respond with just 'OK' to confirm you are working."}
  ],
  "stream": false
}
EOF
)

echo "请求体:"
echo "$REQUEST_BODY" | python3 -m json.tool
echo ""
echo "响应:"

CHAT_RESPONSE=$(curl -s -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d "$REQUEST_BODY")

echo "$CHAT_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$CHAT_RESPONSE"
echo ""

CONTENT=$(echo "$CHAT_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('choices',[{}])[0].get('message',{}).get('content',''))" 2>/dev/null)

if [ -n "$CONTENT" ]; then
    echo -e "${GREEN}✓ 聊天完成成功${NC}"
    echo -e "${GREEN}  回复内容: $CONTENT${NC}"
else
    ERROR=$(echo "$CHAT_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',{}).get('message','Unknown error'))" 2>/dev/null)
    echo -e "${RED}✗ 聊天完成失败: $ERROR${NC}"
    exit 1
fi

echo ""
echo -e "${CYAN}======================================${NC}"
echo -e "${GREEN}   所有测试通过!${NC}"
echo -e "${CYAN}======================================${NC}"
