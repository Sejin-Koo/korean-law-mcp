/**
 * korean-law-mcp — 법제처 국가법령정보 Open API(DRF) MCP 서버
 *
 * 개선 목표 (기존 타사 Korean-law-mcp 대비):
 *  - 가용성: 자체 OC(환경변수 LAW_OC) 사용 → 공유 쿼터 소진 리스크 제거
 *  - 속도: 의존성 0개 단일 파일(콜드스타트 최소), 서울 리전(icn1), 게이트웨이 없이 DRF 직행
 *  - 정확성: 현행/시행예정/연혁 자동 라벨링, 행정규칙 ID 함정 차단, 0건 시 검색어 자동 완화
 *  - 범위: 별표서식(licbyl)·자치법규·조약·영문법령·헌재결정례·법령용어까지 1차 포함
 *
 * 프로토콜: MCP Streamable HTTP (JSON 응답 모드) — initialize / tools/list / tools/call
 */

const BASE = "https://www.law.go.kr/DRF";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) korean-law-mcp";
// 법제처는 OC 신청정보에 도메인이 등록되면 Referer 검증을 활성화함 — 등록 도메인을 Referer로 전송
const REFERER = process.env.LAW_REFERER || "https://korean-law-mcp-five.vercel.app";
const MAX_OUT = 60000; // 응답 텍스트 상한(문자)

// ---------------------------------------------------------------- utilities

function todayKST() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/** 시행일자(YYYYMMDD) → 현행/시행예정 라벨 */
function statusLabel(efYd, histCode) {
  if (histCode && histCode !== "현행" && histCode !== "시행예정") return `[${histCode}]`;
  if (efYd && String(efYd).replace(/[^0-9]/g, "") > todayKST()) return `[시행예정 ${fmtDate(efYd)}]`;
  return "[현행]";
}

function fmtDate(s) {
  const t = String(s || "").replace(/[^0-9]/g, "");
  if (t.length === 8) return `${t.slice(0, 4)}.${t.slice(4, 6)}.${t.slice(6)}`;
  return t && t !== "0" ? String(s) : "-";
}

async function drf(path, params, { timeoutMs = 20000 } = {}) {
  const oc = process.env.LAW_OC;
  if (!oc) throw new Error("환경변수 LAW_OC가 설정되어 있지 않습니다. Vercel Settings > Environment Variables에 LAW_OC(법제처 open.law.go.kr OC)를 등록하고 Redeploy 하세요.");
  const qs = new URLSearchParams({ OC: oc, type: "JSON", ...params });
  const url = `${BASE}/${path}?${qs.toString()}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, "Referer": REFERER }, signal: ctrl.signal });
      const text = await r.text();
      clearTimeout(timer);
      if (!r.ok) throw new Error(`법제처 API HTTP ${r.status}`);
      const trimmed = text.trim();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        // HTML이 오면 대상/파라미터 오류이거나 OC 미등록
        throw new Error(`법제처 API가 JSON이 아닌 응답을 반환했습니다(파라미터 또는 OC 확인 필요). 앞부분: ${trimmed.replace(/\s+/g, " ").slice(0, 160)}`);
      }
      const parsed = JSON.parse(trimmed);
      // 법제처 오류 응답({result, msg})을 0건으로 오인하지 않도록 명시적 오류로 변환
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.msg && parsed.result && Object.keys(parsed).length <= 3) {
        throw new Error(`법제처 API 오류: ${parsed.result} ${parsed.msg} — OC가 유효하지 않거나(신청정보 수정 직후 재승인 대기 등) 파라미터 오류일 수 있습니다.`);
      }
      return parsed;
    } catch (e) {
      clearTimeout(timer);
      if (attempt === 1) throw e;
    }
  }
}

/** 검색 응답에서 단건/배열 정규화 */
function arr(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function clip(s) {
  s = String(s);
  return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n\n…(출력 상한 ${MAX_OUT}자 초과로 생략됨. display/page 또는 jo 파라미터로 범위를 좁혀 다시 조회하세요)` : s;
}

/** HTML 태그/엔티티 간단 제거 */
function strip(s) {
  return String(s || "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** 조번호 입력("제10조의2", "10의2", "10", "001002") → JO 6자리 */
function normalizeJo(jo) {
  if (jo === undefined || jo === null || jo === "") return undefined;
  const s = String(jo).trim();
  if (/^\d{6}$/.test(s)) return s;
  const m = s.match(/(\d+)\s*조?\s*(?:의\s*(\d+))?/);
  if (!m) throw new Error(`조번호 형식을 해석할 수 없습니다: "${jo}" (예: "제38조", "38", "10의2", "001002")`);
  const main = m[1].padStart(4, "0");
  const sub = (m[2] || "0").padStart(2, "0");
  return main + sub;
}

/** 0건이면 앞 2개 토큰으로 완화 재검색하는 공용 로직 */
async function searchWithRelax(target, query, extra, listPath) {
  let data = await drf("lawSearch.do", { target, query, ...extra });
  let root = data[Object.keys(data)[0]] || {};
  let items = arr(listPath(root));
  let note = "";
  const tokens = String(query).trim().split(/\s+/);
  if (items.length === 0 && tokens.length > 2) {
    const relaxed = tokens.slice(0, 2).join(" ");
    data = await drf("lawSearch.do", { target, query: relaxed, ...extra });
    root = data[Object.keys(data)[0]] || {};
    items = arr(listPath(root));
    if (items.length > 0) note = `※ 원 검색어 "${query}" 0건 → 검색어를 "${relaxed}"로 완화해 재검색한 결과입니다.\n\n`;
  }
  return { root, items, note };
}

// ---------------------------------------------------------------- tools

const COMMITTEE = {
  admin_appeal: "decc", ftc: "ftc", privacy: "ppc", labor: "nlrc", acrc: "acr",
  env: "ecc", kcc: "kcc", employment_insurance: "eiac", industrial_accident: "iaciac", land: "oclt",
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const TOOLS = [
  {
    name: "search_law",
    description: "현행 법령(법률·대통령령·부령 등) 검색. 법령명 또는 본문 키워드로 검색해 MST(법령일련번호)·법령ID·시행일·공포일을 반환. 조문 본문이 필요하면 결과의 MST로 get_law_text를 호출.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "검색어 (예: 법인세법)" },
        search: { type: "integer", description: "1=법령명 검색(기본), 2=본문 검색" },
        display: { type: "integer", description: "결과 수 (기본 10, 최대 100)" },
        page: { type: "integer", description: "페이지 (기본 1)" },
      },
      required: ["query"],
    },
    handler: async (a) => {
      const { items, root, note } = await searchWithRelax(
        "law", a.query,
        { search: a.search || 1, display: Math.min(a.display || 10, 100), page: a.page || 1 },
        (r) => r.law
      );
      if (!items.length) return `"${a.query}" 검색 결과가 없습니다. (총 ${root.totalCnt || 0}건)`;
      const lines = items.map((x) =>
        `${statusLabel(x["시행일자"], x["현행연혁코드"])} ${x["법령명한글"]}${x["법령약칭명"] ? ` (약칭: ${x["법령약칭명"]})` : ""}\n` +
        `  MST(법령일련번호): ${x["법령일련번호"]} | 법령ID: ${x["법령ID"]} | ${x["법령구분명"]} | 소관: ${x["소관부처명"]}\n` +
        `  공포 ${fmtDate(x["공포일자"])} (${x["제개정구분명"]}, 공포번호 ${x["공포번호"]}) / 시행 ${fmtDate(x["시행일자"])}`
      );
      return note + `총 ${root.totalCnt}건 중 ${items.length}건 (조회기준일 ${fmtDate(todayKST())})\n\n` + lines.join("\n\n");
    },
  },
  {
    name: "get_law_text",
    description: "법령 조문 원문 조회. mst(권장, search_law의 MST) 또는 law_id로 조회. jo에 조번호를 주면 해당 조문만, 생략하면 조문 목차를 반환. 시행예정 버전 여부를 자동 표기.",
    inputSchema: {
      type: "object",
      properties: {
        mst: { type: "string", description: "법령일련번호(MST) — search_law 결과의 MST. 특정 시점 버전을 가리킴(권장)" },
        law_id: { type: "string", description: "법령ID — MST가 없을 때 사용(항상 현행 기준)" },
        jo: { type: "string", description: "조번호 (예: '제38조', '38', '10의2'). 생략 시 조문 목차 반환" },
        full: { type: "boolean", description: "true면 jo 없이도 전체 조문 본문 반환(응답이 매우 클 수 있음)" },
      },
    },
    handler: async (a) => {
      if (!a.mst && !a.law_id) throw new Error("mst 또는 law_id 중 하나는 필수입니다. search_law로 먼저 MST를 확인하세요.");
      const params = { target: "law" };
      if (a.mst) params.MST = a.mst; else params.ID = a.law_id;
      const jo = normalizeJo(a.jo);
      if (jo) params.JO = jo;
      const data = await drf("lawService.do", params);
      const law = data["법령"] || {};
      const basic = law["기본정보"] || {};
      const efYd = basic["조문별시행일자"] || basic["시행일자"];
      let head =
        `${basic["법령명_한글"] || ""} ${statusLabel(efYd)}\n` +
        `공포 ${fmtDate(basic["공포일자"])} (${basic["제개정구분"] || ""}, 공포번호 ${basic["공포번호"] || ""}) / 시행 ${fmtDate(efYd)} / 소관 ${(basic["소관부처"] || {})["content"] || basic["소관부처명"] || ""}\n` +
        `조회기준일 ${fmtDate(todayKST())} — 위 시행일 버전의 본문입니다.` +
        (String(efYd || "").replace(/[^0-9]/g, "") > todayKST() ? " ⚠ 이 버전은 아직 시행되지 않았습니다. 현행 조문이 필요하면 search_law에서 [현행] MST를 확인하세요." : "") + "\n\n";
      const units = arr((law["조문"] || {})["조문단위"]);
      if (!units.length) return head + "(조문 데이터가 없습니다)";
      if (jo) {
        const body = units.map((u) => renderJo(u)).join("\n\n");
        return clip(head + body);
      }
      if (a.full) return clip(head + units.map((u) => renderJo(u)).join("\n\n"));
      // 목차 모드
      const toc = units
        .filter((u) => u["조문여부"] === "조문")
        .map((u) => `제${u["조문번호"]}조${u["조문가지번호"] && u["조문가지번호"] !== "0" ? `의${u["조문가지번호"]}` : ""} ${strip(u["조문제목"] || "")}`);
      return clip(head + `[조문 목차 — 본문은 jo 파라미터로 조회]\n` + toc.join("\n"));
    },
  },
  {
    name: "get_law_history",
    description: "법령의 연혁·시행예정 타임라인 조회(시행일자별 버전 목록). 개정 추적과 '현행 vs 시행예정' 구분에 사용.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "법령명 (예: 법인세법)" },
        display: { type: "integer", description: "버전 수 (기본 20)" },
      },
      required: ["query"],
    },
    handler: async (a) => {
      const data = await drf("lawSearch.do", { target: "eflaw", query: a.query, display: Math.min(a.display || 20, 100), sort: "efdes" });
      const root = data.LawSearch || {};
      const all = arr(root.law);
      const exact = all.filter((x) => x["법령명한글"] === a.query.trim());
      const list = exact.length ? exact : all;
      if (!list.length) return `"${a.query}"의 연혁을 찾지 못했습니다.`;
      const lines = list.map((x) =>
        `${statusLabel(x["시행일자"], x["현행연혁코드"])} 시행 ${fmtDate(x["시행일자"])} | 공포 ${fmtDate(x["공포일자"])} (${x["제개정구분명"]}, 공포번호 ${x["공포번호"]}) | MST ${x["법령일련번호"]} | ${x["법령명한글"]}`
      );
      return `총 ${root.totalCnt}건 (조회기준일 ${fmtDate(todayKST())}, 시행일 내림차순)\n\n` + lines.join("\n");
    },
  },
  {
    name: "search_admin_rule",
    description: "행정규칙(고시·훈령·예규·지침) 검색. 법률이 아닌 규범(예: 중소기업회계기준 고시)은 search_law가 아니라 이 도구를 사용. 본문은 결과의 '행정규칙일련번호'로 get_admin_rule 호출.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "검색어" },
        display: { type: "integer", description: "결과 수 (기본 10)" },
      },
      required: ["query"],
    },
    handler: async (a) => {
      const { items, root, note } = await searchWithRelax(
        "admrul", a.query, { display: Math.min(a.display || 10, 100) }, (r) => r.admrul
      );
      if (!items.length) return `"${a.query}" 행정규칙 검색 결과가 없습니다.`;
      const lines = items.map((x) =>
        `${x["행정규칙명"]} (${x["행정규칙종류"] || ""})\n` +
        `  행정규칙일련번호(본문조회용): ${x["행정규칙일련번호"]} | 행정규칙ID(본문조회에 사용 금지): ${x["행정규칙ID"] || "-"}\n` +
        `  소관: ${x["소관부처명"]} | 발령 ${fmtDate(x["발령일자"])} | 시행 ${fmtDate(x["시행일자"])} | ${x["현행연혁구분"] || ""}`
      );
      return note + `총 ${root.totalCnt}건 중 ${items.length}건\n\n` + lines.join("\n\n");
    },
  },
  {
    name: "get_admin_rule",
    description: "행정규칙 본문 조회. id에는 반드시 search_admin_rule 결과의 '행정규칙일련번호'(13자리)를 입력 (행정규칙ID를 넣으면 조회 실패).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "행정규칙일련번호 (13자리, 예: 2000000022226)" },
      },
      required: ["id"],
    },
    handler: async (a) => {
      const id = String(a.id).trim();
      if (id.length < 10) {
        throw new Error(`"${id}"는 행정규칙ID로 보입니다. 본문 조회에는 13자리 '행정규칙일련번호'가 필요합니다. search_admin_rule 결과의 '행정규칙일련번호(본문조회용)' 값을 사용하세요.`);
      }
      const data = await drf("lawService.do", { target: "admrul", ID: id });
      const svc = data.AdmRulService || {};
      const basic = svc["행정규칙기본정보"] || {};
      let out =
        `${basic["행정규칙명"] || ""} (${basic["행정규칙종류"] || ""})\n` +
        `소관 ${basic["소관부처명"] || ""} | 발령 ${fmtDate(basic["발령일자"])} (발령번호 ${basic["발령번호"] || ""}) | 시행 ${fmtDate(basic["시행일자"])}\n\n`;
      const artRoot = svc["조문"] || {};
      const arts = arr(artRoot["조문단위"] || artRoot["조"] || svc["조문내용"]);
      if (arts.length) {
        out += arts.map((u) => (typeof u === "string" ? strip(u) : strip(u["조문내용"] || JSON.stringify(u)))).join("\n\n");
      }
      const annexes = arr((svc["별표"] || {})["별표단위"]);
      if (annexes.length) {
        out += `\n\n[별표·서식 ${annexes.length}건]\n` + annexes.map((b) =>
          `- ${b["별표구분"] || ""} ${b["별표번호"] ? `제${Number(b["별표번호"])}호` : ""} ${strip(b["별표제목"] || "")}` +
          (b["별표서식파일링크"] ? ` | 파일: https://www.law.go.kr${b["별표서식파일링크"]}` : "")
        ).join("\n");
      }
      return clip(out);
    },
  },
  {
    name: "search_precedent",
    description: "법원 판례 검색(대법원·하급심). 사건번호를 알면 case_number로 정확 조회. 키워드는 AND 조건이므로 2~3단어 권장(0건이면 자동으로 완화 재검색). 본문은 결과의 판례일련번호로 get_precedent 호출.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "키워드 (2~3단어 권장, 예: '해고 무효')" },
        case_number: { type: "string", description: "사건번호 정확 조회 (예: 2025다213906)" },
        court: { type: "string", description: "법원명 필터 (예: 대법원)" },
        search: { type: "integer", description: "1=사건명 검색(기본), 2=본문 검색" },
        display: { type: "integer", description: "결과 수 (기본 10)" },
      },
    },
    handler: async (a) => {
      if (!a.query && !a.case_number) throw new Error("query 또는 case_number 중 하나는 필수입니다.");
      const extra = { display: Math.min(a.display || 10, 100) };
      if (a.court) extra.curt = a.court;
      if (a.search) extra.search = a.search;
      let root, items, note = "";
      if (a.case_number) {
        const data = await drf("lawSearch.do", { target: "prec", nb: a.case_number, ...extra });
        root = data.PrecSearch || {};
        items = arr(root.prec);
      } else {
        ({ root, items, note } = await searchWithRelax("prec", a.query, extra, (r) => r.prec));
      }
      if (!items.length) return `판례 검색 결과가 없습니다. (키워드를 2~3단어로 줄이거나 case_number로 조회해 보세요. 그래도 없으면 '관련 판례를 찾지 못함'으로 처리하고 판례를 지어내지 마세요.)`;
      const lines = items.map((x) =>
        `${x["법원명"]} ${fmtDate(x["선고일자"])} ${x["선고"] || ""} ${x["사건번호"]} (${x["사건종류명"] || ""}, ${x["판결유형"] || ""})\n` +
        `  사건명: ${x["사건명"]}\n  판례일련번호(본문조회용): ${x["판례일련번호"]}`
      );
      return note + `총 ${root.totalCnt || items.length}건 중 ${items.length}건\n\n` + lines.join("\n\n");
    },
  },
  {
    name: "get_precedent",
    description: "판례 본문 조회(판시사항·판결요지·전문). id는 search_precedent 결과의 판례일련번호.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "판례일련번호" } },
      required: ["id"],
    },
    handler: async (a) => {
      const data = await drf("lawService.do", { target: "prec", ID: String(a.id).trim() });
      const s = data.PrecService || {};
      let out =
        `${s["법원명"] || ""} ${fmtDate(s["선고일자"])} 선고 ${s["사건번호"] || ""} ${s["사건명"] || ""}\n\n` +
        `■ 판시사항\n${strip(s["판시사항"]) || "(없음)"}\n\n` +
        `■ 판결요지\n${strip(s["판결요지"]) || "(없음)"}\n\n` +
        `■ 참조조문\n${strip(s["참조조문"]) || "(없음)"}\n\n` +
        `■ 참조판례\n${strip(s["참조판례"]) || "(없음)"}\n\n` +
        `■ 전문\n${strip(s["판례내용"]) || "(없음)"}`;
      return clip(out);
    },
  },
  {
    name: "search_interpretation",
    description: "법제처 법령해석례 검색. 본문은 결과의 법령해석례일련번호로 get_interpretation 호출.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "검색어" },
        display: { type: "integer", description: "결과 수 (기본 10)" },
      },
      required: ["query"],
    },
    handler: async (a) => {
      const { items, root, note } = await searchWithRelax("expc", a.query, { display: Math.min(a.display || 10, 100) }, (r) => r.expc);
      if (!items.length) return `"${a.query}" 법령해석례 검색 결과가 없습니다.`;
      const lines = items.map((x) =>
        `${x["안건명"]}\n  안건번호 ${x["안건번호"] || "-"} | 해석기관 ${x["해석기관명"] || "-"} | 회신 ${fmtDate(x["회신일자"])}\n  법령해석례일련번호(본문조회용): ${x["법령해석례일련번호"]}`
      );
      return note + `총 ${root.totalCnt}건 중 ${items.length}건\n\n` + lines.join("\n\n");
    },
  },
  {
    name: "get_interpretation",
    description: "법령해석례 본문 조회(질의요지·회답·이유). id는 search_interpretation 결과의 법령해석례일련번호.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "법령해석례일련번호" } },
      required: ["id"],
    },
    handler: async (a) => {
      const data = await drf("lawService.do", { target: "expc", ID: String(a.id).trim() });
      const s = data.ExpcService || {};
      return clip(
        `${s["안건명"] || ""}\n안건번호 ${s["안건번호"] || "-"} | 해석기관 ${s["해석기관명"] || s["해석기관코드"] || "-"} | 회신 ${fmtDate(s["회신일자"])}\n\n` +
        `■ 질의요지\n${strip(s["질의요지"]) || "(없음)"}\n\n■ 회답\n${strip(s["회답"]) || "(없음)"}\n\n■ 이유\n${strip(s["이유"]) || "(없음)"}`
      );
    },
  },
  {
    name: "search_annex",
    description: "법령의 별표·서식 검색(licbyl). 별표/서식 명칭 또는 관련 법령명으로 검색하며, HWP/PDF 파일 다운로드 링크를 반환. '별표9', '별지 제1호서식' 같은 부속자료 확인에 사용.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "검색어 (예: 법인세, 감가상각)" },
        display: { type: "integer", description: "결과 수 (기본 10)" },
      },
      required: ["query"],
    },
    handler: async (a) => {
      const { items, root, note } = await searchWithRelax("licbyl", a.query, { display: Math.min(a.display || 10, 100) }, (r) => r.licbyl);
      if (!items.length) return `"${a.query}" 별표·서식 검색 결과가 없습니다.`;
      const lines = items.map((x) =>
        `[${x["별표종류"] || ""}${x["별표번호"] ? ` 제${Number(x["별표번호"].slice(0, 4))}호${Number(x["별표번호"].slice(4)) ? `의${Number(x["별표번호"].slice(4))}` : ""}` : ""}] ${x["별표명"] || ""} — ${x["관련법령명"]}\n` +
        `  소관 ${x["소관부처명"] || "-"} | 관련법령 MST ${x["관련법령일련번호"] || "-"} (공포 ${fmtDate(x["공포일자"])})` +
        (x["별표서식파일링크"] ? `\n  HWP: https://www.law.go.kr${x["별표서식파일링크"]}` : "") +
        (x["별표서식PDF파일링크"] ? ` | PDF: https://www.law.go.kr${x["별표서식PDF파일링크"]}` : "")
      );
      return note + `총 ${root.totalCnt}건 중 ${items.length}건\n\n` + lines.join("\n\n");
    },
  },
  {
    name: "search_ordinance",
    description: "지방자치단체 자치법규(조례·규칙) 검색.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "검색어 (예: 주차장 설치)" },
        display: { type: "integer", description: "결과 수 (기본 10)" },
      },
      required: ["query"],
    },
    handler: async (a) => {
      const { items, root, note } = await searchWithRelax("ordin", a.query, { display: Math.min(a.display || 10, 100) }, (r) => r.law);
      if (!items.length) return `"${a.query}" 자치법규 검색 결과가 없습니다.`;
      const lines = items.map((x) =>
        `${x["자치법규명"]} (${x["자치법규종류"] || ""}) — ${x["지자체기관명"] || ""}\n` +
        `  자치법규ID ${x["자치법규ID"]} | 공포 ${fmtDate(x["공포일자"])} | 시행 ${fmtDate(x["시행일자"])}`
      );
      return note + `총 ${root.totalCnt}건 중 ${items.length}건\n\n` + lines.join("\n\n");
    },
  },
  {
    name: "search_constitutional_decision",
    description: "헌법재판소 결정례 검색.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "검색어" },
        display: { type: "integer", description: "결과 수 (기본 10)" },
      },
      required: ["query"],
    },
    handler: async (a) => {
      const { items, root, note } = await searchWithRelax("detc", a.query, { display: Math.min(a.display || 10, 100) }, (r) => r.Detc || r.detc);
      if (!items.length) return `"${a.query}" 헌재결정례 검색 결과가 없습니다.`;
      const lines = items.map((x) =>
        `${x["사건명"] || ""}\n  ${x["사건번호"] || ""} | 종국일자 ${fmtDate(x["종국일자"])} | 헌재결정례일련번호: ${x["헌재결정례일련번호"] || x["헌재결정례ID"] || "-"}`
      );
      return note + `총 ${root.totalCnt}건 중 ${items.length}건\n\n` + lines.join("\n\n");
    },
  },
  {
    name: "search_committee_decision",
    description: "10개 위원회 결정례·재결례 통합검색. source: admin_appeal(중앙·시도 행정심판), ftc(공정거래위), privacy(개인정보보호위), labor(노동위), acrc(국민권익위), env(중앙환경분쟁조정위), kcc(방송미디어통신위), employment_insurance(고용보험심사위), industrial_accident(산재보상보험재심사위), land(중앙토지수용위). 본문은 결과의 일련번호로 get_committee_decision 호출. (조세심판원·관세·소청심사는 법제처 API 미제공)",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["admin_appeal", "ftc", "privacy", "labor", "acrc", "env", "kcc", "employment_insurance", "industrial_accident", "land"], description: "위원회 구분" },
        query: { type: "string", description: "검색어 (2~3단어 권장)" },
        display: { type: "integer", description: "결과 수 (기본 10)" },
      },
      required: ["source", "query"],
    },
    handler: async (a) => {
      const target = COMMITTEE[a.source];
      if (!target) throw new Error(`알 수 없는 source: ${a.source}`);
      const { items, root, note } = await searchWithRelax(target, a.query, { display: Math.min(a.display || 10, 100) }, (r) => {
        for (const k of Object.keys(r)) if (Array.isArray(r[k]) || (r[k] && typeof r[k] === "object" && r[k]["사건번호"])) return r[k];
        return r[target] || r[target.toLowerCase()] || r[cap(target)];
      });
      if (!items.length) return `"${a.query}" ${a.source} 결정례 검색 결과가 없습니다.`;
      const lines = items.map((x) => {
        const serialKey = Object.keys(x).find((k) => k.endsWith("일련번호"));
        const title = x["사건명"] || x["안건명"] || x["제목"] || "";
        const date = x["의결일자"] || x["결정일자"] || x["재결일자"] || x["처분일자"] || "";
        return `${title}\n  사건번호 ${x["사건번호"] || "-"} | ${x["재결청"] || x["회의종류"] || x["기관명"] || ""} | 일자 ${fmtDate(date)}\n  일련번호(본문조회용): ${serialKey ? x[serialKey] : "-"}`;
      });
      return note + `총 ${root.totalCnt || items.length}건 중 ${items.length}건\n\n` + lines.join("\n\n");
    },
  },
  {
    name: "get_committee_decision",
    description: "위원회 결정례·재결례 본문 조회. source는 search_committee_decision과 동일, id는 검색 결과의 일련번호.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["admin_appeal", "ftc", "privacy", "labor", "acrc", "env", "kcc", "employment_insurance", "industrial_accident", "land"], description: "위원회 구분" },
        id: { type: "string", description: "결정문/재결례 일련번호" },
      },
      required: ["source", "id"],
    },
    handler: async (a) => {
      const target = COMMITTEE[a.source];
      if (!target) throw new Error(`알 수 없는 source: ${a.source}`);
      const data = await drf("lawService.do", { target, ID: String(a.id).trim() });
      const root = data[Object.keys(data)[0]] || {};
      const PRIORITY = ["사건명", "안건명", "사건번호", "재결청", "처분청", "의결일자", "결정일자", "재결일자", "청구취지", "신청취지", "주문", "청구요지", "재결요지", "결정요지", "이유", "판단", "결정문내용", "재결례내용"];
      const seen = new Set();
      const parts = [];
      for (const k of PRIORITY) {
        if (root[k] !== undefined && String(root[k]).trim() !== "") {
          parts.push(`■ ${k}\n${strip(root[k])}`);
          seen.add(k);
        }
      }
      for (const [k, v] of Object.entries(root)) {
        if (seen.has(k) || v === null || typeof v === "object") continue;
        const s = strip(v).trim();
        if (s) parts.push(`■ ${k}\n${s}`);
      }
      return clip(parts.join("\n\n") || "(본문 데이터가 없습니다)");
    },
  },
  {
    name: "search_english_law",
    description: "영문 번역 법령 검색 (영문 계약서·해외 제출용).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "검색어 (영문 또는 국문)" },
        display: { type: "integer", description: "결과 수 (기본 10)" },
      },
      required: ["query"],
    },
    handler: async (a) => {
      const data = await drf("lawSearch.do", { target: "elaw", query: a.query, display: Math.min(a.display || 10, 100) });
      const root = data.LawSearch || {};
      const items = arr(root.law);
      if (!items.length) return `"${a.query}" 영문법령 검색 결과가 없습니다.`;
      const lines = items.map((x) =>
        `${x["법령명한글"] || ""} / ${x["법령명영문"] || ""}\n  MST ${x["법령일련번호"]} | 공포 ${fmtDate(x["공포일자"])} | 시행 ${fmtDate(x["시행일자"])}`
      );
      return `총 ${root.totalCnt}건 중 ${items.length}건\n\n` + lines.join("\n\n");
    },
  },
  {
    name: "search_treaty",
    description: "대한민국이 체결한 조약 검색(조세조약·투자협정 등).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "검색어 (예: 이중과세 미국)" },
        display: { type: "integer", description: "결과 수 (기본 10)" },
      },
      required: ["query"],
    },
    handler: async (a) => {
      const { items, root, note } = await searchWithRelax("trty", a.query, { display: Math.min(a.display || 10, 100) }, (r) => r.Trty || r.trty);
      if (!items.length) return `"${a.query}" 조약 검색 결과가 없습니다.`;
      const lines = items.map((x) =>
        `${x["조약명"] || x["조약명한글"] || ""}\n  조약번호 ${x["조약번호"] || "-"} | 발효 ${fmtDate(x["발효일자"])} | 조약일련번호 ${x["조약일련번호"] || "-"}`
      );
      return note + `총 ${root.totalCnt}건 중 ${items.length}건\n\n` + lines.join("\n\n");
    },
  },
  {
    name: "search_law_term",
    description: "법령용어사전 검색 — 법령상 용어의 공식 정의 확인.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "용어 (예: 소규모합병)" },
        display: { type: "integer", description: "결과 수 (기본 10)" },
      },
      required: ["query"],
    },
    handler: async (a) => {
      const data = await drf("lawSearch.do", { target: "lstrm", query: a.query, display: Math.min(a.display || 5, 20) });
      const root = data.LsTrmSearch || {};
      const items = arr(root.lstrm);
      if (!items.length) return `"${a.query}" 법령용어 검색 결과가 없습니다.`;
      // 정확 일치 우선 정렬 후 상위 5건의 정의를 병렬 조회
      items.sort((x, y) => (x["법령용어명"] === a.query.trim() ? -1 : 0) - (y["법령용어명"] === a.query.trim() ? -1 : 0));
      const top = items.slice(0, 5);
      const defs = await Promise.all(top.map(async (x) => {
        try {
          const d = await drf("lawService.do", { target: "lstrm", trmSeqs: x["법령용어ID"] });
          return strip((d.LsTrmService || {})["법령용어정의"] || "").trim() || "(정의 없음)";
        } catch { return "(정의 조회 실패)"; }
      }));
      const lines = top.map((x, i) => `■ ${x["법령용어명"]}\n${defs[i]}`);
      return `총 ${root.totalCnt}건 중 상위 ${top.length}건 (정의 포함)\n\n` + lines.join("\n\n");
    },
  },
];

/** 조문단위 렌더링 */
function renderJo(u) {
  let out = "";
  const num = u["조문번호"];
  const branch = u["조문가지번호"];
  const title = strip(u["조문제목"] || "");
  const body = strip(u["조문내용"] || "");
  if (u["조문여부"] === "조문" && !body.trim().startsWith(`제${num}조`)) {
    out += `제${num}조${branch && branch !== "0" ? `의${branch}` : ""}${title ? `(${title})` : ""} `;
  }
  out += body;
  const hangs = arr(u["항"]);
  for (const h of hangs) {
    out += "\n" + strip(h["항내용"] || "");
    for (const ho of arr(h["호"])) {
      out += "\n  " + strip(ho["호내용"] || "");
      for (const mok of arr(ho["목"])) {
        out += "\n    " + strip(arr(mok["목내용"]).join("\n    "));
      }
    }
  }
  if (u["조문시행일자"]) out += `\n(조문 시행일: ${fmtDate(u["조문시행일자"])})`;
  return out;
}

// ---------------------------------------------------------------- MCP protocol

const SERVER_INFO = { name: "korean-law-mcp", version: "1.0.0" };

async function handleRpc(msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
      try {
        const text = await tool.handler(params?.arguments || {});
        return reply({ content: [{ type: "text", text: String(text) }] });
      } catch (e) {
        return reply({ content: [{ type: "text", text: `오류: ${e.message}` }], isError: true });
      }
    }
    default:
      if (method && method.startsWith("notifications/")) return null; // no response
      return fail(-32601, `Method not found: ${method}`);
  }
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: true, server: SERVER_INFO.name, version: SERVER_INFO.version, tools: TOOLS.length }));
  }
  if (req.method !== "POST") { res.statusCode = 405; return res.end("Method Not Allowed"); }

  let msg;
  try { msg = await readBody(req); }
  catch { res.statusCode = 400; return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })); }

  try {
    const isBatch = Array.isArray(msg);
    const msgs = isBatch ? msg : [msg];
    const replies = [];
    for (const m of msgs) {
      const r = await handleRpc(m);
      if (r) replies.push(r);
    }
    if (!replies.length) { res.statusCode = 202; return res.end(); }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(isBatch ? replies : replies[0]));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: e.message } }));
  }
}
