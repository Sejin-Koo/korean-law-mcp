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

/**
 * 법령명 검색(search=1) 결과 재정렬용.
 *
 * 법제처 lawSearch는 법령명 검색을 "부분일치 + 법령명 가나다순"으로 처리한다.
 * 그래서 "상법"처럼 짧은 검색어는 "보상법·배상법·기상법·형사보상법" 등에 밀려
 * 뒤로 가고(실측: 56건 중 34번째), display 기본값 10건 안에 들어오지 못해
 * 에러 없이 조용히 누락된다. 완전일치 > 접두일치 > 부분일치 순으로 끌어올린다.
 */
// 영문법령(elaw) 등 일부 target은 검색어에 <strong> 하이라이트 태그를 끼워 반환하므로 먼저 제거한다.
const normName = (s) => strip(s).replace(/\s+/g, "").toLowerCase();

/** fields는 우선순위 순(앞쪽 필드에서 일치할수록 상위). 0~9=완전일치, 10~19=접두일치, 20~29=부분일치 */
function nameMatchRank(item, q, fields) {
  const nq = normName(q);
  if (!nq) return 99;
  let best = 99;
  fields.forEach((f, i) => {
    const n = normName(item[f]);
    if (!n) return;
    if (n === nq) best = Math.min(best, i);
    else if (n.startsWith(nq)) best = Math.min(best, 10 + i);
    else if (n.includes(nq)) best = Math.min(best, 20 + i);
  });
  return best;
}

/** 원래 순서를 보존하는 안정 정렬(같은 등급 안에서는 법제처 반환 순서 유지) */
function rerankByName(items, q, fields) {
  return items
    .map((x, i) => ({ x, i, r: nameMatchRank(x, q, fields) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((e) => e.x);
}

/**
 * 이름 기반 검색 도구 공통 처리.
 * 넉넉히(100건) 받아 완전일치 우선으로 재정렬한 뒤 요청한 display 건수로 잘라 준다.
 */
async function nameSearch({ target, query, extra = {}, listPath, fields, display, label = "항목" }) {
  const want = Math.min(display || 10, 100);
  const wide = want < 100;
  const { items: rawItems, root, note } = await searchWithRelax(
    target, query, { ...extra, display: wide ? 100 : want }, listPath
  );
  if (!rawItems.length) return { items: [], root, note, rerankNote: "" };
  const sorted = rerankByName(rawItems, query, fields);
  const items = wide ? sorted.slice(0, want) : sorted;
  let rerankNote = "";
  const promoted = items.filter((x) => rawItems.indexOf(x) >= items.length);
  if (promoted.length) {
    rerankNote =
      `※ 법제처 검색은 부분일치 + 이름 가나다순이라 검색어와 정확히 일치하는 항목(${label})이 뒤로 밀립니다. ` +
      `"${query}"에 더 가깝게 일치하는 ${promoted.length}건을 앞으로 재정렬했습니다.\n\n`;
  }
  const total = Number(root.totalCnt) || 0;
  // 접두일치조차 없으면(>19) 완전일치가 100건 밖에 있을 수 있으므로 경고
  if (wide && total > 100 && nameMatchRank(items[0], query, fields) > 19) {
    rerankNote +=
      `※ 총 ${total}건 중 앞 100건만 확인했고 그 안에 이름이 "${query}"로 시작하는 항목(${label})이 없습니다. ` +
      `검색어를 더 구체적으로 바꾸거나 display를 100으로 지정해 확인하세요.\n\n`;
  }
  return { items, root, note, rerankNote };
}

// ---------------------------------------------------------------- 판례·결정례 랭킹

/** "2016.7.18." / "20240712" → 20160718 형태의 비교용 정수 */
function dateKey(s) {
  const m = String(s || "").match(/(\d{4})\D*(\d{1,2})\D*(\d{1,2})/);
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : 0;
}

/**
 * 판례의 법원명 판정.
 * 법제처 판례 DB에는 출처가 다른 두 계열이 섞여 있고, 국세법령정보시스템 계열은
 * 법원명 필드가 비어 있는 대신 사건번호가 "대법원-2024-다-233854" 형태다.
 * 그래서 curt(법원명) 파라미터를 API에 그대로 넘기면 이 계열이 통째로 탈락한다
 * (실측: "중간배당" 전체 10건 → curt=대법원 0건, 그중 2건이 실제 대법원 사건).
 */
function courtOf(x) {
  const n = String(x["법원명"] || "").trim();
  if (n) return n;
  const m = String(x["사건번호"] || "").match(/^([가-힣]+법원)/);
  return m ? m[1] : "";
}

/** 사건번호 정규화 — "대법원-2024-다-233854"와 "2024다233854"를 같은 건으로 본다 */
function caseKey(x) {
  return String(x["사건번호"] || "").replace(/^[가-힣]+법원-/, "").replace(/[\s\-·]/g, "");
}

/** 법원 위계(대법원>고법·특허>그 밖의 법원>불명) + 전원합의체 가산 */
function precRank(x) {
  const c = courtOf(x);
  let tier = 3;
  if (/대법원/.test(c)) tier = 0;
  else if (/고등법원|특허법원/.test(c)) tier = 1;
  else if (/법원/.test(c)) tier = 2;
  const plenary = /전원합의체/.test(`${x["사건명"] || ""}${x["판결유형"] || ""}${x["선고"] || ""}`);
  return tier * 2 + (plenary ? 0 : 1);
}

/** 검색어 토큰 중 제목에 포함된 개수(많을수록 상위) */
function tokenCoverage(title, q) {
  const t = normName(title);
  return String(q).trim().split(/\s+/).filter((tk) => tk && t.includes(normName(tk))).length;
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
    description: "현행 법령(법률·대통령령·부령 등) 검색. 법령명 또는 본문 키워드로 검색해 MST(법령일련번호)·법령ID·시행일·공포일을 반환. 조문 본문이 필요하면 결과의 MST로 get_law_text를 호출. 법제처 법령명 검색은 부분일치(예: '상법'이 '보상법·배상법'에도 걸림) + 가나다순이므로, 이 서버가 1페이지 요청에 한해 완전일치·접두일치를 앞으로 자동 재정렬해 반환한다.",
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
      const mode = a.search || 1;
      const want = Math.min(a.display || 10, 100);
      const page = a.page || 1;
      // 법령명 검색 1페이지는 넉넉히(100건) 받아 완전일치 우선으로 재정렬한 뒤 잘라 준다.
      const wide = mode === 1 && page === 1 && want < 100;
      const { items: raw, root, note } = await searchWithRelax(
        "law", a.query,
        { search: mode, display: wide ? 100 : want, page },
        (r) => r.law
      );
      if (!raw.length) return `"${a.query}" 검색 결과가 없습니다. (총 ${root.totalCnt || 0}건)`;

      const LAW_FIELDS = ["법령명한글", "법령약칭명"];
      let items = raw;
      let rerankNote = "";
      if (mode === 1) {
        const sorted = rerankByName(raw, a.query, LAW_FIELDS);
        items = wide ? sorted.slice(0, want) : sorted;
        const promoted = items.filter((x) => raw.indexOf(x) >= items.length);
        if (promoted.length) {
          rerankNote =
            `※ 법제처 법령명 검색은 부분일치·가나다순이라 "${a.query}"에 정확히 대응하는 법령이 뒤로 밀립니다. ` +
            `완전일치·접두일치 ${promoted.length}건을 앞으로 재정렬했습니다.\n\n`;
        }
        const total = Number(root.totalCnt) || 0;
        if (wide && total > 100 && nameMatchRank(items[0], a.query, LAW_FIELDS) > 9) {
          rerankNote +=
            `※ 총 ${total}건 중 앞 100건만 확인했고 그 안에 완전일치 법령이 없습니다. ` +
            `검색어를 더 구체적으로 바꾸거나 page를 넘겨 확인하세요.\n\n`;
        }
      }

      const lines = items.map((x) =>
        `${statusLabel(x["시행일자"], x["현행연혁코드"])} ${x["법령명한글"]}${x["법령약칭명"] ? ` (약칭: ${x["법령약칭명"]})` : ""}\n` +
        `  MST(법령일련번호): ${x["법령일련번호"]} | 법령ID: ${x["법령ID"]} | ${x["법령구분명"]} | 소관: ${x["소관부처명"]}\n` +
        `  공포 ${fmtDate(x["공포일자"])} (${x["제개정구분명"]}, 공포번호 ${x["공포번호"]}) / 시행 ${fmtDate(x["시행일자"])}`
      );
      return note + rerankNote + `총 ${root.totalCnt}건 중 ${items.length}건 (조회기준일 ${fmtDate(todayKST())})\n\n` + lines.join("\n\n");
    },
  },
  {
    name: "get_law_text",
    description: "법령 조문 원문 조회. mst(권장, search_law의 MST) 또는 law_id로 조회. jo에 조번호를 주면 해당 조문만, 생략하면 조문 목차를 반환. jo='부칙'(또는 '부칙 <공포번호|공포일>')이면 부칙(시행일·경과조치)을 반환. 본문은 시행일법령 기준이라 먼저 공포됐지만 시행이 늦은 판이 현행일 때도 그 사이 신설·개정 조문이 반영된다. 현행/연혁/시행예정을 연혁 목록으로 판정해 표기하고, 연혁 버전이면 현행 MST를 함께 안내.",
    inputSchema: {
      type: "object",
      properties: {
        mst: { type: "string", description: "법령일련번호(MST) — search_law 결과의 MST. 특정 시점 버전을 가리킴(권장)" },
        law_id: { type: "string", description: "법령ID — MST가 없을 때 사용(항상 현행 기준)" },
        jo: { type: "string", description: "조번호 (예: '제38조', '38', '10의2'). 생략 시 조문 목차 반환. '부칙'이면 최근 부칙 3건 본문과 전체 부칙 목록, '부칙 21448'(공포번호)·'부칙 2026.3.6'(공포일)이면 그 부칙만(경과조치·시행일 단서 확인용)" },
        full: { type: "boolean", description: "true면 jo 없이도 전체 조문 본문 반환(응답이 매우 클 수 있음)" },
      },
    },
    handler: async (a) => {
      if (!a.mst && !a.law_id) throw new Error("mst 또는 law_id 중 하나는 필수입니다. search_law로 먼저 MST를 확인하세요.");
      const addenda = parseAddendaQuery(a.jo);
      const jo = addenda ? undefined : normalizeJo(a.jo);
      const { law, source, label, note } = await resolveLawText({ mst: a.mst, lawId: a.law_id, jo });
      const basic = law["기본정보"] || {};
      const efYd = String(basic["시행일자"] || basic["조문별시행일자"] || "").replace(/[^0-9]/g, "");
      const lawName = basic["법령명_한글"] || "";
      let head =
        `${lawName} ${label || statusLabel(efYd)}\n` +
        `공포 ${fmtDate(basic["공포일자"])} (${basic["제개정구분"] || ""}, 공포번호 ${basic["공포번호"] || ""}) / 시행 ${fmtDate(efYd)} / 소관 ${(basic["소관부처"] || {})["content"] || basic["소관부처명"] || ""}\n` +
        `조회기준일 ${fmtDate(todayKST())} — 위 시행일 버전의 본문입니다.` +
        (efYd > todayKST() ? " ⚠ 이 버전은 아직 시행되지 않았습니다. 현행 조문이 필요하면 search_law에서 [현행] MST를 확인하세요." : "") +
        (note ? `\n${note}` : "") +
        (source === "law" ? "\n※ 시행일법령 본문 조회에 실패해 현행법령 API 본문으로 대신 응답했습니다. 나중에 공포된 개정 조문이 빠져 있을 수 있으니 get_law_history로 개정 이력을 함께 확인하세요." : "") +
        "\n\n";
      if (addenda) return clip(head + renderAddenda(law, addenda));
      const units = arr((law["조문"] || {})["조문단위"]);
      if (!units.length) {
        return head + (jo
          ? `(이 시행일 버전에 해당 조문이 없습니다. 신설·삭제 여부는 get_law_history로 다른 시행일 버전과 대조하세요)`
          : "(조문 데이터가 없습니다)");
      }
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
      const { items, root, note, rerankNote } = await nameSearch({
        target: "admrul", query: a.query, display: a.display,
        fields: ["행정규칙명"], label: "행정규칙", listPath: (r) => r.admrul,
      });
      if (!items.length) return `"${a.query}" 행정규칙 검색 결과가 없습니다.`;
      const lines = items.map((x) =>
        `${x["행정규칙명"]} (${x["행정규칙종류"] || ""})\n` +
        `  행정규칙일련번호(본문조회용): ${x["행정규칙일련번호"]} | 행정규칙ID(본문조회에 사용 금지): ${x["행정규칙ID"] || "-"}\n` +
        `  소관: ${x["소관부처명"]} | 발령 ${fmtDate(x["발령일자"])} | 시행 ${fmtDate(x["시행일자"])} | ${x["현행연혁구분"] || ""}`
      );
      return note + rerankNote + `총 ${root.totalCnt}건 중 ${items.length}건\n\n` + lines.join("\n\n");
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
    description: "법원 판례 검색(대법원·하급심). 사건번호를 알면 case_number로 정확 조회. 키워드는 AND 조건이므로 2~3단어 권장(0건이면 자동으로 완화 재검색). 본문은 결과의 판례일련번호로 get_precedent 호출. court(법원명) 필터는 법제처 API에 넘기지 않고 서버가 사건번호·법원명 양쪽으로 판정해 거르므로, 법원명 필드가 비어 있는 국세법령정보시스템 계열 판례도 누락되지 않는다. 결과는 법원 위계(대법원>고법>그 밖) → 전원합의체 → 선고일 최신 순으로 정렬되고 같은 사건번호는 1건으로 합친다.",
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
      const want = Math.min(a.display || 10, 100);
      // court는 curt로 넘기지 않는다 — 법원명이 빈 계열이 통째로 탈락하므로 아래에서 로컬 판정한다.
      const extra = { display: 100 };
      if (a.search) extra.search = a.search;
      let root, items, note = "";
      if (a.case_number) {
        const data = await drf("lawSearch.do", { target: "prec", nb: a.case_number, ...extra });
        root = data.PrecSearch || {};
        items = arr(root.prec);
      } else {
        ({ root, items, note } = await searchWithRelax("prec", a.query, extra, (r) => r.prec));
      }
      const fetched = items.length;

      // ① 법원 필터를 로컬 판정으로 적용
      let filterNote = "";
      if (a.court) {
        const key = String(a.court).trim();
        const kept = items.filter((x) => courtOf(x).includes(key));
        const rescued = kept.filter((x) => !String(x["법원명"] || "").trim()).length;
        items = kept;
        if (rescued) {
          filterNote = `※ 법원명 필드가 비어 있어 법제처 API 필터로는 탈락했을 판례 ${rescued}건을 사건번호로 판정해 포함했습니다.\n\n`;
        }
      }
      // ② 사건번호 기준 중복 제거
      const seen = new Set();
      const deduped = [];
      let dupCount = 0;
      for (const x of items) {
        const k = caseKey(x) || `#${x["판례일련번호"]}`;
        if (seen.has(k)) { dupCount++; continue; }
        seen.add(k);
        deduped.push(x);
      }
      // ③ 법원 위계 → 전원합의체 → 선고일 최신 순
      const ranked = deduped
        .map((x, i) => ({ x, i, r: precRank(x), d: dateKey(x["선고일자"]) }))
        .sort((p, q) => p.r - q.r || q.d - p.d || p.i - q.i)
        .map((e) => e.x);
      const shown = ranked.slice(0, want);

      if (!shown.length) {
        return a.court
          ? `"${a.court}" 판례를 찾지 못했습니다. (검색 자체는 ${fetched}건이 나왔으나 법원 필터에서 모두 제외됨 — court 없이 다시 조회해 보세요.)`
          : `판례 검색 결과가 없습니다. (키워드를 2~3단어로 줄이거나 case_number로 조회해 보세요. 그래도 없으면 '관련 판례를 찾지 못함'으로 처리하고 판례를 지어내지 마세요.)`;
      }
      const dupNote = dupCount ? `※ 사건번호가 같은 중복 ${dupCount}건을 합쳤습니다.\n\n` : "";
      const lines = shown.map((x) =>
        `${courtOf(x) || "(법원명 미표기)"} ${fmtDate(x["선고일자"])} ${x["선고"] || ""} ${x["사건번호"]} (${x["사건종류명"] || ""}${x["판결유형"] ? `, ${x["판결유형"]}` : ""})\n` +
        `  사건명: ${x["사건명"]}\n` +
        `  판례일련번호(본문조회용): ${x["판례일련번호"]} | 출처: ${x["데이터출처명"] || "-"}`
      );
      return note + filterNote + dupNote +
        `총 ${root.totalCnt || fetched}건 중 ${shown.length}건 (법원 위계 → 선고일 최신 순)\n\n` + lines.join("\n\n");
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
      const want = Math.min(a.display || 10, 100);
      const { items: raw, root, note } = await searchWithRelax("expc", a.query, { display: 100 }, (r) => r.expc);
      if (!raw.length) return `"${a.query}" 법령해석례 검색 결과가 없습니다.`;
      // 안건명은 "OO시 - 「법률」 제N조(질의요지) 관련" 형식이라 완전일치가 무의미 —
      // 검색어 토큰 커버리지 → 회신일 최신 순으로 정렬한다.
      const items = raw
        .map((x, i) => ({ x, i, c: tokenCoverage(x["안건명"], a.query), d: dateKey(x["회신일자"]) }))
        .sort((p, q) => q.c - p.c || q.d - p.d || p.i - q.i)
        .map((e) => e.x)
        .slice(0, want);
      const lines = items.map((x) =>
        `${x["안건명"]}\n  안건번호 ${x["안건번호"] || "-"} | 해석기관 ${x["해석기관명"] || x["회신기관명"] || "-"} | 회신 ${fmtDate(x["회신일자"])}\n  법령해석례일련번호(본문조회용): ${x["법령해석례일련번호"]}`
      );
      return note + `총 ${root.totalCnt}건 중 ${items.length}건 (검색어 적합도 → 회신일 최신 순)\n\n` + lines.join("\n\n");
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
      const { items, root, note, rerankNote } = await nameSearch({
        target: "licbyl", query: a.query, display: a.display,
        fields: ["별표명", "관련법령명"], label: "별표·서식", listPath: (r) => r.licbyl,
      });
      if (!items.length) return `"${a.query}" 별표·서식 검색 결과가 없습니다.`;
      const lines = items.map((x) =>
        `[${x["별표종류"] || ""}${x["별표번호"] ? ` 제${Number(x["별표번호"].slice(0, 4))}호${Number(x["별표번호"].slice(4)) ? `의${Number(x["별표번호"].slice(4))}` : ""}` : ""}] ${x["별표명"] || ""} — ${x["관련법령명"]}\n` +
        `  소관 ${x["소관부처명"] || "-"} | 관련법령 MST ${x["관련법령일련번호"] || "-"} (공포 ${fmtDate(x["공포일자"])})` +
        (x["별표서식파일링크"] ? `\n  HWP: https://www.law.go.kr${x["별표서식파일링크"]}` : "") +
        (x["별표서식PDF파일링크"] ? ` | PDF: https://www.law.go.kr${x["별표서식PDF파일링크"]}` : "")
      );
      return note + rerankNote + `총 ${root.totalCnt}건 중 ${items.length}건\n\n` + lines.join("\n\n");
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
      const { items, root, note, rerankNote } = await nameSearch({
        target: "ordin", query: a.query, display: a.display,
        fields: ["자치법규명"], label: "자치법규", listPath: (r) => r.law,
      });
      if (!items.length) return `"${a.query}" 자치법규 검색 결과가 없습니다.`;
      const lines = items.map((x) =>
        `${x["자치법규명"]} (${x["자치법규종류"] || ""}) — ${x["지자체기관명"] || ""}\n` +
        `  자치법규ID ${x["자치법규ID"]} | 공포 ${fmtDate(x["공포일자"])} | 시행 ${fmtDate(x["시행일자"])}`
      );
      return note + rerankNote + `총 ${root.totalCnt}건 중 ${items.length}건\n\n` + lines.join("\n\n");
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
      const want = Math.min(a.display || 10, 100);
      const { items: raw, root, note } = await searchWithRelax("detc", a.query, { display: 100 }, (r) => r.Detc || r.detc);
      if (!raw.length) return `"${a.query}" 헌재결정례 검색 결과가 없습니다.`;
      const items = raw
        .map((x, i) => ({ x, i, c: tokenCoverage(x["사건명"], a.query), d: dateKey(x["종국일자"]) }))
        .sort((p, q) => q.c - p.c || q.d - p.d || p.i - q.i)
        .map((e) => e.x)
        .slice(0, want);
      const lines = items.map((x) =>
        `${x["사건명"] || ""}\n  ${x["사건번호"] || ""} | 종국일자 ${fmtDate(x["종국일자"])} | 헌재결정례일련번호: ${x["헌재결정례일련번호"] || x["헌재결정례ID"] || "-"}`
      );
      return note + `총 ${root.totalCnt}건 중 ${items.length}건 (검색어 적합도 → 종국일 최신 순)\n\n` + lines.join("\n\n");
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
      const want = Math.min(a.display || 10, 100);
      const { items: raw, root, note } = await searchWithRelax(target, a.query, { display: 100 }, (r) => {
        for (const k of Object.keys(r)) if (Array.isArray(r[k]) || (r[k] && typeof r[k] === "object" && r[k]["사건번호"])) return r[k];
        return r[target] || r[target.toLowerCase()] || r[cap(target)];
      });
      if (!raw.length) return `"${a.query}" ${a.source} 결정례 검색 결과가 없습니다.`;
      const dateOf = (x) => x["의결일자"] || x["결정일자"] || x["재결일자"] || x["처분일자"] || "";
      const titleOf = (x) => x["사건명"] || x["안건명"] || x["제목"] || "";
      // 안건명이 "OO의 OO 위반행위에 대한 건" 형식이라 완전일치가 무의미하고,
      // 법제처 기본 정렬이 안건명 가나다순이라 최신 결정례가 뒤로 밀린다 → 일자 최신 우선.
      const items = raw
        .map((x, i) => ({ x, i, d: dateKey(dateOf(x)), p: /전\s*원/.test(String(x["회의종류"] || "")) ? 0 : 1 }))
        .sort((m, n) => n.d - m.d || m.p - n.p || m.i - n.i)
        .map((e) => e.x)
        .slice(0, want);
      const lines = items.map((x) => {
        const serialKey = Object.keys(x).find((k) => k.endsWith("일련번호"));
        return `${titleOf(x)}\n  사건번호 ${x["사건번호"] || "-"} | ${x["재결청"] || x["회의종류"] || x["기관명"] || ""} | 일자 ${fmtDate(dateOf(x))}\n  일련번호(본문조회용): ${serialKey ? x[serialKey] : "-"}`;
      });
      return note + `총 ${root.totalCnt || raw.length}건 중 ${items.length}건 (일자 최신 순)\n\n` + lines.join("\n\n");
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
      const { items, root, note, rerankNote } = await nameSearch({
        target: "elaw", query: a.query, display: a.display,
        fields: ["법령명한글", "법령명영문", "법령약칭명"], label: "영문법령", listPath: (r) => r.law,
      });
      if (!items.length) return `"${a.query}" 영문법령 검색 결과가 없습니다.`;
      const lines = items.map((x) =>
        `${strip(x["법령명한글"])} / ${strip(x["법령명영문"])}\n  MST ${x["법령일련번호"]} | 공포 ${fmtDate(x["공포일자"])} | 시행 ${fmtDate(x["시행일자"])}`
      );
      return note + rerankNote + `총 ${root.totalCnt}건 중 ${items.length}건\n\n` + lines.join("\n\n");
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
      const { items, root, note, rerankNote } = await nameSearch({
        target: "trty", query: a.query, display: a.display,
        fields: ["조약명", "조약명한글"], label: "조약", listPath: (r) => r.Trty || r.trty,
      });
      if (!items.length) return `"${a.query}" 조약 검색 결과가 없습니다.`;
      const lines = items.map((x) =>
        `${x["조약명"] || x["조약명한글"] || ""}\n  조약번호 ${x["조약번호"] || "-"} | 발효 ${fmtDate(x["발효일자"])} | 조약일련번호 ${x["조약일련번호"] || "-"}`
      );
      return note + rerankNote + `총 ${root.totalCnt}건 중 ${items.length}건\n\n` + lines.join("\n\n");
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

/**
 * 조문 본문은 '시행일법령(eflaw)' API로 받는다.
 *
 * 왜: '현행법령(law)' API는 MST별로 공포 시점에 만들어진 본문을 돌려주므로, 먼저 공포됐지만
 * 시행이 늦은 개정판이 [현행]으로 지정되면 그 사이에 공포·시행된 개정 조문이 빠진다.
 * 실측(2026-10-23): 상법 [현행] MST 273629(공포 2025-09-09·시행 2026-09-10)를 law로 조회하면
 * 2026-03-06 신설 제341조의4(자기주식 소각의무)가 "조문 없음"으로 나오지만, 같은 MST를
 * eflaw(efYd=20260910)로 조회하면 정상 반환된다. 오류가 아닌 정상 응답이라 조용히 틀린다.
 *
 * eflaw는 MST만 주면 HTML 오류를 내고 efYd(시행일자)가 함께 있어야 한다. 그런데 MST 하나에
 * 시행일이 여럿인 개정이 흔하고(예: 법인세법 MST 280349 = 시행 2026-01-01·2026-07-01),
 * law API의 기본정보 시행일자는 그중 하나만 준다. 그래서 연혁 목록에서 그 MST의 시행일들을
 * 모아 ①현행 표시가 붙은 시행일 ②없으면 오늘 이전 가장 늦은 시행일 ③모두 미래면 가장 이른
 * 시행일 순으로 efYd를 고른다. 같은 목록으로 [현행]/[연혁]/[시행예정] 라벨도 정한다
 * (statusLabel은 시행일만 봐서, 이미 대체된 과거 판도 [현행]으로 표기하던 문제가 있었다 —
 * 실측: 상법 MST 284143 시행 2026-03-06 판).
 *
 * ID 경로는 eflaw가 바로 현행을 준다. eflaw가 실패하면 law 본문으로 폴백하고 응답 머리에 표기한다.
 */
async function lawVersions(lawName) {
  if (!lawName) return [];
  try {
    const data = await drf("lawSearch.do", { target: "eflaw", query: lawName, display: 100, sort: "efdes" });
    return arr((data.LawSearch || {}).law).filter((x) => x["법령명한글"] === lawName);
  } catch (_) {
    return [];
  }
}

function pickVersion(list, mst) {
  const mine = list.filter((x) => String(x["법령일련번호"]) === String(mst));
  if (!mine.length) return null;
  const today = todayKST();
  const cur = mine.find((x) => x["현행연혁코드"] === "현행");
  if (cur) return cur;
  const past = mine.filter((x) => String(x["시행일자"]) <= today).sort((a, b) => String(b["시행일자"]).localeCompare(String(a["시행일자"])));
  if (past.length) return past[0];
  return mine.sort((a, b) => String(a["시행일자"]).localeCompare(String(b["시행일자"])))[0];
}

async function resolveLawText({ mst, lawId, jo }) {
  const joParam = jo ? { JO: jo } : {};
  if (!mst) {
    try {
      const d = await drf("lawService.do", { target: "eflaw", ID: lawId, ...joParam });
      if (d && d["법령"]) return { law: d["법령"], source: "eflaw" };
    } catch (_) { /* 폴백 */ }
    const d = await drf("lawService.do", { target: "law", ID: lawId, ...joParam });
    return { law: d["법령"] || {}, source: "law" };
  }
  const first = await drf("lawService.do", { target: "law", MST: mst, ...joParam });
  const law0 = first["법령"] || {};
  const basic0 = law0["기본정보"] || {};
  const list = await lawVersions(basic0["법령명_한글"]);
  const v = pickVersion(list, mst);
  const efYd = String((v && v["시행일자"]) || basic0["시행일자"] || "").replace(/[^0-9]/g, "");
  let label, note;
  if (v) {
    label = statusLabel(v["시행일자"], v["현행연혁코드"]);
    if (v["현행연혁코드"] === "연혁") {
      const cur = list.find((x) => x["현행연혁코드"] === "현행");
      note = cur
        ? `⚠ 이 버전은 연혁(과거) 버전입니다. 현행은 MST ${cur["법령일련번호"]}(공포 ${fmtDate(cur["공포일자"])} / 시행 ${fmtDate(cur["시행일자"])})입니다.`
        : "⚠ 이 버전은 연혁(과거) 버전입니다.";
    }
  }
  if (efYd.length === 8) {
    try {
      const d = await drf("lawService.do", { target: "eflaw", MST: mst, efYd, ...joParam });
      if (d && d["법령"]) return { law: d["법령"], source: "eflaw", label, note };
    } catch (_) { /* 폴백 */ }
  }
  return { law: law0, source: "law", label, note };
}

/**
 * 부칙 조회. 조문 API는 부칙을 조문 단위로 주지 않지만 본문 응답의 "부칙.부칙단위"에 공포 회차별로 들어 있다.
 * 경과조치(예: 상법 제21448호 부칙 제2조 — 기존 자기주식 소각 유예)는 여기에만 있으므로 2차 출처로 대신하지 않게 한다.
 * jo 표기: "부칙"(최근 3건 + 목록) / "부칙 21448"(공포번호) / "부칙 2026.3.6"·"부칙 20260306"(공포일)
 */
function parseAddendaQuery(jo) {
  if (jo === undefined || jo === null) return null;
  const s = String(jo).trim();
  if (!/^부칙/.test(s)) return null;
  const rest = s.replace(/^부칙\s*/, "").replace(/^[<(]|[>)]$/g, "").trim();
  if (!rest) return { latest: 3 };
  const digits = rest.replace(/[^0-9]/g, "");
  if (/[.\-]/.test(rest) || digits.length === 8) {
    const parts = rest.split(/[.\-\s]+/).filter(Boolean);
    const d = parts.length >= 3 ? parts[0].padStart(4, "0") + parts[1].padStart(2, "0") + parts[2].padStart(2, "0") : digits;
    return { date: d };
  }
  return { no: digits.replace(/^제|호$/g, "") };
}

function flattenText(x) {
  if (x === undefined || x === null) return [];
  if (Array.isArray(x)) return x.flatMap(flattenText);
  if (typeof x === "object") return flattenText(x.content ?? Object.values(x));
  return [strip(String(x))];
}

function renderAddenda(law, q) {
  const units = arr((law["부칙"] || {})["부칙단위"])
    .map((u) => ({ date: String(u["부칙공포일자"] || ""), no: String(u["부칙공포번호"] || ""), lines: flattenText(u["부칙내용"]) }))
    .sort((x, y) => (y.date + y.no.padStart(6, "0")).localeCompare(x.date + x.no.padStart(6, "0")));
  if (!units.length) return "(이 버전 응답에 부칙 데이터가 없습니다. get_law_history로 해당 개정의 MST를 찾아 다시 조회하세요)";
  const index = units.map((u) => `- 부칙 <제${Number(u.no) || u.no}호, ${fmtDate(u.date)}>`).join("\n");
  let pick;
  if (q.no) pick = units.filter((u) => Number(u.no) === Number(q.no));
  else if (q.date) pick = units.filter((u) => u.date === q.date);
  else pick = units.slice(0, q.latest || 3);
  if (!pick.length) return `(지정한 부칙을 찾지 못했습니다. 이 버전에 실린 부칙 목록:)\n${index}`;
  const body = pick.map((u) => u.lines.join("\n")).join("\n\n");
  const head = q.no || q.date ? "" : `[최근 부칙 ${pick.length}건 — 특정 부칙은 jo='부칙 <공포번호>'로 조회]\n\n`;
  return head + body + `\n\n[이 버전에 실린 부칙 ${units.length}건 — 최신순]\n` + index;
}

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

// ── MCP 프로토콜 버전 협상 ──────────────────────────────────────────────────
// 규격 근거 두 가지.
//  (1) Lifecycle "Version Negotiation": 서버는 요청받은 버전을 지원하면 같은 값으로,
//      지원하지 않으면 "자기가 지원하는" 다른 버전으로 응답해야 한다(MUST).
//      요청값을 그대로 반향하면 존재하지 않는 프로토콜도 지원한다고 답하게 된다.
//  (2) Transports "Protocol Version Header": MCP-Protocol-Version 헤더가 미지원
//      버전이면 400 Bad Request 로 응답해야 한다(MUST). 이 400은 신형(2026-07-28)
//      클라이언트가 HTTP에서 구형 서버를 판별해 폴백하는 유일한 신호이기도 하므로,
//      200 으로 통과시키면 신형 클라이언트가 이 서버를 신형으로 오인한다.
// 목록은 @modelcontextprotocol/sdk 의 SUPPORTED_PROTOCOL_VERSIONS 와 동일하게 맞춰,
// SDK 기반 서버들과 협상 결과가 갈리지 않도록 한다.
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

// 헤더가 없으면 통과한다(규격상 서버는 2025-03-26 으로 간주). 값이 있으면 대조한다.
function protocolVersionHeaderError(req) {
  const raw = req.headers && req.headers["mcp-protocol-version"];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || SUPPORTED_PROTOCOL_VERSIONS.includes(v)) return null;
  return {
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: `Bad Request: Unsupported protocol version: ${v} (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`,
    },
    id: null,
  };
}

async function handleRpc(msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
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

// ─── 접근 게이트 ─────────────────────────────────────────────────────────────
// 엔드포인트 주소만 알면 누구나 호출할 수 있는 상태를 막기 위해, 호출자는 URL
// 쿼리스트링으로 발급받은 게이트키를 전달한다:  https://<도메인>/api/mcp?k=<발급키>
//   MCP_GATE_KEYS : 허용 키 목록(쉼표 구분). **비어 있으면 게이트 비활성**(모두 통과).
//   MCP_GATE_MODE : "enforce"면 키가 없거나 목록에 없을 때 401 차단.
//                   그 밖(기본 "observe")이면 통과시키되 로그만 남긴다.
// 로그에는 키 전문 대신 발급 대상 식별자(plk_<대상>_… 의 <대상>)만 남긴다.
// 상세 운영 절차는 sys-mcp-gatekey 스킬 참조.
const GATE_KEYS = (process.env.MCP_GATE_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const GATE_MODE = (process.env.MCP_GATE_MODE || "observe").trim().toLowerCase();

function gateKeyLabel(k) {
  if (!k) return "(none)";
  const m = String(k).match(/^plk_([A-Za-z0-9]+)_/);
  return m ? m[1] : `${String(k).slice(0, 8)}…`;
}

/** 통과하면 true. 차단하면 401 응답을 보내고 false를 돌려준다. */
function gateCheck(req, res) {
  let k = (req.query && req.query.k) || null;
  if (!k) {
    try {
      k = new URL(req.url, "http://localhost").searchParams.get("k");
    } catch (e) {
      k = null;
    }
  }
  const allowed = GATE_KEYS.length === 0 || (!!k && GATE_KEYS.includes(k));
  console.log(
    `[gate] mode=${GATE_MODE} method=${req.method} caller=${gateKeyLabel(k)} allowed=${allowed}`
  );
  if (!allowed && GATE_MODE === "enforce") {
    res.statusCode = 401;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32001,
          message:
            "접근 권한이 없습니다. 이 서버는 발급받은 게이트키가 포함된 주소(…/api/mcp?k=<발급키>)로만 호출할 수 있습니다.",
        },
      })
    );
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (!gateCheck(req, res)) return;

  const pvError = protocolVersionHeaderError(req);
  if (pvError) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(pvError));
  }

  if (req.method === "GET") {
    // 규격상 GET 은 SSE 스트림(text/event-stream) 아니면 405 여야 한다. MCP
    // 클라이언트(Accept 에 text/event-stream 을 싣는다)에는 405 로 답하고,
    // 브라우저·헬스체크 용도의 평범한 GET 에는 기존 상태 JSON 을 그대로 준다.
    const accept = String((req.headers && req.headers.accept) || "");
    if (accept.includes("text/event-stream")) {
      res.statusCode = 405;
      res.setHeader("Allow", "POST, GET, OPTIONS");
      return res.end();
    }
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
