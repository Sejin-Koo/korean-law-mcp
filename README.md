# korean-law-mcp

법제처 국가법령정보 Open API(DRF)를 감싸는 자체 호스팅 MCP 서버.

- 엔드포인트: `https://<배포도메인>/api/mcp`
- 환경변수: `LAW_OC` — open.law.go.kr에서 발급받은 OC(이메일 ID)
- 도구 17개: search_law, get_law_text, get_law_history, search_admin_rule, get_admin_rule,
  search_precedent, get_precedent, search_interpretation, get_interpretation,
  search_annex, search_ordinance, search_constitutional_decision,
  search_committee_decision, get_committee_decision (10개 위원회),
  search_english_law, search_treaty, search_law_term
