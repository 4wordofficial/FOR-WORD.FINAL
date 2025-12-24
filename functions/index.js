/**
 * FOR:WORD — Cloud Functions (2nd gen)
 *
 * What this version fixes/improves:
 *  1) CORS / Cloud Run invoker: keep Gen2 callable endpoints publicly invokable at the Cloud Run layer
 *     while still enforcing Firebase Auth inside functions that require it.
 *  2) Tagging taxonomy: forces tags into (대주제=top_topic / 중간주제=mid_topic / 개인주제=personal_topic)
 *     so you do NOT get generic buckets like "기타" for meaningful memos.
 *  3) Firestore field compatibility: analytics functions now read BOTH snake_case and camelCase
 *     (because your app currently writes camelCase: mainTopic, primaryTags, detailTags, etc.)
 *
 * Deploy:
 *   cd functions
 *   npm install
 *   firebase deploy --only functions
 */

const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

// OpenAI SDK (CJS compatibility)
const OpenAIImport = require("openai");
const OpenAI = OpenAIImport.default || OpenAIImport;

// ───────────────── init ─────────────────
if (!getApps().length) initializeApp();
const db = getFirestore();

// IMPORTANT: Gen2 runs on Cloud Run. If the service is not public, browsers will see
// a CORS error on OPTIONS preflight because Cloud Run returns 401/403 without CORS headers.
setGlobalOptions({
  region: "asia-northeast3",
  // Make HTTP/callable endpoints publicly invokable at the Cloud Run layer.
  // (You still enforce Firebase Auth inside with requireAuth()).
  invoker: "public",
});

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

// ───────────────── Taxonomy (대주제/중간주제) ─────────────────
// NOTE: You can freely edit these lists later. The important part is:
// - top_topic must be one of the keys
// - mid_topic must be one of the values under that top_topic
// - personal_topic is a short user-specific label (free text)
const TAXONOMY = {
  "정서": [
    "불안",
    "외로움",
    "슬픔",
    "기쁨",
    "분노",
    "평온",
    "자존감",
    "상처",
    "회복",
    "감사",
  ],
  "사랑": [
    "그리움",
    "이별",
    "헌신",
    "집착",
    "신뢰",
    "오해",
    "거리두기",
    "용서",
    "소통",
    "돌봄",
  ],
  "창작": [
    "비유·상징",
    "문장 수집",
    "주제 발상",
    "서사·구성",
    "톤·리듬",
    "캐릭터",
    "장면·묘사",
    "대사",
    "퇴고",
    "작업 루틴",
  ],
  "일상": [
    "습관",
    "시간관리",
    "수면",
    "운동",
    "식사",
    "정리",
    "기록",
    "집안",
  ],
  "업무": [
    "기획",
    "개발",
    "디자인",
    "마케팅",
    "운영",
    "협업",
    "실험·지표",
    "고객",
  ],
  "학습": [
    "독서",
    "연구",
    "정리",
    "철학",
    "심리",
    "기술",
    "언어",
    "커리어 학습",
  ],
  "계획": [
    "목표",
    "전략",
    "의사결정",
    "리스크",
    "재정",
    "커리어",
    "계획수립",
  ],
  "사회": [
    "문화",
    "예술",
    "사회이슈",
    "가치관",
    "윤리",
    "역사",
  ],
  // 마지막 안전망 (정말 분류 불가할 때만)
  "기타": ["기타"],
};

const TOP_TOPICS = Object.keys(TAXONOMY);

// If you want to ban "기타" as an output unless absolutely needed:
const GENERIC_TOPICS = new Set(["기타", "미분류", "일반", "잡다", "기본"]);
const GENERIC_WORDS = new Set([
  "기타",
  "미분류",
  "일반",
  "잡다",
  "기본",
  "관계",
  "감정",
  "삶의 영역",
  "테마/모티프",
  "상황/장면",
]);

function normalizeKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[·•\-_/]/g, "");
}

function bestMatchKey(candidate, pool) {
  const c = normalizeKey(candidate);
  if (!c) return null;

  // exact normalized match
  for (const p of pool) {
    if (normalizeKey(p) === c) return p;
  }
  // contains match (loose)
  for (const p of pool) {
    const pn = normalizeKey(p);
    if (pn.includes(c) || c.includes(pn)) return p;
  }
  return null;
}

function uniqKeepOrder(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const t = String(x || "").trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// ───────────────── 시스템 프롬프트(태깅) ─────────────────
// We push the taxonomy into the prompt, and still enforce it in code (double safety).
const SYSTEM_PROMPT = `
당신은 한국어 메모를 (대주제/중간주제/개인주제)로 강제 분류하고 태그를 붙여주는 엔진입니다.

입력: 짧은 메모(일기, 단상, 문장, 서비스 기획 메모 등)
주의: 은유/비유 표현이 많습니다. 은유는 직설 의미로 풀어쓴 뒤 분류하세요.

[대주제(top_topic) 후보 목록]
${TOP_TOPICS.map((t) => `- ${t}`).join("\n")}

[중간주제(mid_topic) 후보 목록]
${TOP_TOPICS.map((t) => `- ${t}: ${TAXONOMY[t].join(", ")}`).join("\n")}

규칙:
1) top_topic은 반드시 '대주제 후보 목록' 중 하나를 EXACT 문자열로 선택.
2) mid_topic은 반드시 '해당 top_topic 아래의 중간주제 후보' 중 하나를 EXACT 문자열로 선택.
3) personal_topic은 사용자 고유의 짧은 라벨(3~20자)로 작성:
   - 예: "겨울을 내어줌", "끝없는 그리움", "빈 문서 공포"
   - 너무 일반적인 단어 금지: "기타/일반/미분류" 같은 값 금지.
4) primary_tags는 반드시 [top_topic, mid_topic, personal_topic] 3개를 포함.
5) detail_tags는 4~10개: 구체 상황/상징/장면/감정 디테일 (한국어 짧은 명사구)
6) 어떤 경우에도 JSON만 출력.

출력(JSON only):
{
  "summary": "직설적 한줄 요약",
  "top_topic": "대주제",
  "mid_topic": "중간주제",
  "personal_topic": "개인주제",
  "primary_tags": ["...", "...", "..."],
  "detail_tags": ["...", "..."]
}
`.trim();

// ───────────────── CORS (Callable) ─────────────────
// Callable functions can restrict allowed origins. Keep it explicit for your Hosting domain.
const ALLOWED_ORIGINS = [
  "https://forword-7af6f.web.app",
  "https://forword-7af6f.firebaseapp.com",
  // local dev
  /^http:\/\/localhost:\d+$/,
];

// ───────────────── 공용 유틸 ─────────────────
function requireAuth(req) {
  const uid = req?.auth?.uid || null;
  if (!uid) throw new HttpsError("unauthenticated", "Login required.");
  return uid;
}
function normArr(a) {
  return Array.isArray(a) ? a.map((t) => String(t || "").trim()).filter(Boolean) : [];
}
function jaccard(aArr, bArr) {
  const A = new Set(normArr(aArr));
  const B = new Set(normArr(bArr));
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const v of A) if (B.has(v)) inter++;
  const union = new Set([...A, ...B]).size || 1;
  return inter / union;
}
function firstLine(s, n = 60) {
  const t = String(s || "").split(/\r?\n/)[0] || "";
  return t.slice(0, n);
}

async function callChatJSON({
  apiKey,
  system,
  user,
  temperature = 0.2,
  response_format = { type: "json_object" },
}) {
  const client = new OpenAI({ apiKey });
  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature,
    response_format,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return completion.choices?.[0]?.message?.content?.trim() ?? "";
}

function normalizeTopMidPersonal(parsed) {
  // accept both snake_case and camelCase keys
  const rawTop =
    String(parsed?.top_topic || parsed?.topTopic || parsed?.topic_axis || "").trim() || "";
  const rawMid =
    String(parsed?.mid_topic || parsed?.midTopic || parsed?.topic_category || "").trim() || "";
  const rawPersonal =
    String(parsed?.personal_topic || parsed?.personalTopic || "").trim() || "";

  const matchedTop = bestMatchKey(rawTop, TOP_TOPICS);
  let top = matchedTop || "기타";

  // If top is generic and we have a better hint from mid, try to infer:
  if (GENERIC_TOPICS.has(top) && rawMid) {
    // find which top contains this mid
    for (const t of TOP_TOPICS) {
      const m = bestMatchKey(rawMid, TAXONOMY[t]);
      if (m) {
        top = t;
        break;
      }
    }
  }

  const midPool = TAXONOMY[top] || ["기타"];
  const matchedMid = bestMatchKey(rawMid, midPool);
  let mid = matchedMid || midPool[0] || "기타";

  // personal_topic: must not be generic; if generic or empty, derive from other tags later
  const personal = rawPersonal && !GENERIC_WORDS.has(rawPersonal) ? rawPersonal : "";

  return { top, mid, personal };
}

function pickPersonalFallback({ personal, detail_tags, primary_tags }) {
  if (personal && !GENERIC_WORDS.has(personal)) return personal;

  // Prefer a non-generic primary tag that is NOT exactly a top/mid label
  const candidates = []
    .concat(primary_tags || [])
    .concat(detail_tags || [])
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .filter((t) => !GENERIC_WORDS.has(t));

  return candidates[0] || "개인주제";
}

// ───────────────── 태깅 내부 로직 ─────────────────
async function extractMeaningTags({ text, memoId, apiKey }) {
  const userPayload = JSON.stringify({ memoId, text: String(text || "").slice(0, 1500) });
  const raw = await callChatJSON({
    apiKey,
    system: SYSTEM_PROMPT,
    user: userPayload,
    temperature: 0.1,
  });

  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      summary: "",
      top_topic: null,
      mid_topic: null,
      personal_topic: null,
      topic_axis: null,
      topic_category: null,
      main_topic: null,
      primary_tags: [],
      detail_tags: [],
      tags: [],
      debugReason: "PARSE_ERROR",
      debugRaw: raw,
    };
  }

  const summary = String(parsed?.summary || "").trim();

  const primaryFromModel = normArr(parsed?.primary_tags || parsed?.primaryTags || []);
  const detail_tags = normArr(parsed?.detail_tags || parsed?.detailTags || []);

  // Normalize top/mid/personal (forced)
  let { top, mid, personal } = normalizeTopMidPersonal(parsed);

  // If top ended up as "기타" but the memo is clearly emotional/relationship, try a tiny heuristic:
  // (This is optional but helps prevent "기타" on poetic memos.)
  if (top === "기타") {
    const joined = `${text} ${primaryFromModel.join(" ")} ${detail_tags.join(" ")}`;
    if (/(사랑|그리움|이별|연인|관계|너|그대|우리|헌신|집착|용서)/.test(joined)) top = "사랑";
    else if (/(불안|두려움|외로움|슬픔|우울|회복|자존감|상처)/.test(joined)) top = "정서";
    else if (/(문장|비유|상징|작가|서사|장면|퇴고|대사)/.test(joined)) top = "창작";
    mid = (TAXONOMY[top] && TAXONOMY[top][0]) || mid || "기타";
  }

  // If mid is still generic while top is meaningful, choose a better mid by looking at content
  if ((mid === "기타" || GENERIC_WORDS.has(mid)) && top !== "기타") {
    const joined = `${text} ${primaryFromModel.join(" ")} ${detail_tags.join(" ")}`;
    const mids = TAXONOMY[top] || [];
    // crude scoring: pick first mid whose keyword appears in text/tags
    let chosen = mids[0] || "기타";
    for (const m of mids) {
      if (m && joined.includes(m.replace(/[·•]/g, ""))) {
        chosen = m;
        break;
      }
    }
    mid = chosen;
  }

  // Personal topic fallback
  personal = pickPersonalFallback({
    personal,
    detail_tags,
    primary_tags: primaryFromModel,
  });

  // Primary tags: MUST include [top, mid, personal]
  const primary_tags = uniqKeepOrder([top, mid, personal, ...primaryFromModel]).slice(0, 6);

  // main_topic should be a stable bucket. Use mid (more specific than top).
  const main_topic =
    mid && !GENERIC_WORDS.has(mid)
      ? mid
      : top && !GENERIC_WORDS.has(top)
      ? top
      : personal;

  return {
    summary,
    top_topic: top,
    mid_topic: mid,
    personal_topic: personal,
    // keep old fields for backward-compat
    topic_axis: top, // treat as axis
    topic_category: mid, // treat as category
    main_topic,
    primary_tags,
    detail_tags,
    tags: uniqKeepOrder([...primary_tags, ...detail_tags]),
    debugReason: null,
    debugRaw: raw,
  };
}

// ───────────────── 단일 메모 태깅 ─────────────────
exports.tagMemo = onCall(
  {
    cors: ALLOWED_ORIGINS,
    timeoutSeconds: 20,
    secrets: [OPENAI_API_KEY],
  },
  async (req) => {
    const text = String(req?.data?.text || "").trim();
    const memoId = req?.data?.id ?? null;

    if (!text) {
      return {
        top_topic: null,
        mid_topic: null,
        personal_topic: null,
        topic_axis: null,
        topic_category: null,
        main_topic: null,
        primary_tags: [],
        detail_tags: [],
        tags: [],
        debugReason: "EMPTY_TEXT",
        debugRaw: "",
      };
    }

    const apiKey = OPENAI_API_KEY.value();
    if (!apiKey) {
      return {
        top_topic: null,
        mid_topic: null,
        personal_topic: null,
        topic_axis: null,
        topic_category: null,
        main_topic: null,
        primary_tags: [],
        detail_tags: [],
        tags: [],
        debugReason: "MISSING_API_KEY",
        debugRaw: "",
      };
    }

    try {
      const out = await extractMeaningTags({ text, memoId, apiKey });
      return {
        summary: out.summary,

        top_topic: out.top_topic,
        mid_topic: out.mid_topic,
        personal_topic: out.personal_topic,

        topic_axis: out.topic_axis,
        topic_category: out.topic_category,
        main_topic: out.main_topic,

        primary_tags: out.primary_tags,
        detail_tags: out.detail_tags,
        tags: out.tags,

        debugReason: out.debugReason,
        debugRaw: out.debugRaw,
      };
    } catch (err) {
      return {
        top_topic: null,
        mid_topic: null,
        personal_topic: null,
        topic_axis: null,
        topic_category: null,
        main_topic: null,
        primary_tags: [],
        detail_tags: [],
        tags: [],
        debugReason: "UNCAUGHT_ERROR",
        debugRaw: String(err),
      };
    }
  }
);

// ───────────────── batch 태깅(홈 INBOX 초기 태깅용) ─────────────────
exports.tagMemos = onCall(
  {
    cors: ALLOWED_ORIGINS,
    timeoutSeconds: 20,
    secrets: [OPENAI_API_KEY],
  },
  async (req) => {
    const memos = Array.isArray(req?.data?.memos) ? req.data.memos : [];
    if (!memos.length) return { results: [] };

    const apiKey = OPENAI_API_KEY.value();
    const results = [];

    for (const m of memos) {
      const memoId = m?.id ?? null;
      const text = String(m?.text || "").trim();

      if (!text) {
        results.push({
          id: memoId,
          top_topic: null,
          mid_topic: null,
          personal_topic: null,
          topic_axis: null,
          topic_category: null,
          main_topic: null,
          primary_tags: [],
          detail_tags: [],
          tags: [],
          debugReason: "EMPTY_TEXT",
          debugRaw: "",
        });
        continue;
      }

      if (!apiKey) {
        results.push({
          id: memoId,
          top_topic: null,
          mid_topic: null,
          personal_topic: null,
          topic_axis: null,
          topic_category: null,
          main_topic: null,
          primary_tags: [],
          detail_tags: [],
          tags: [],
          debugReason: "MISSING_API_KEY",
          debugRaw: "",
        });
        continue;
      }

      try {
        const out = await extractMeaningTags({ text, memoId, apiKey });
        results.push({
          id: memoId,

          top_topic: out.top_topic,
          mid_topic: out.mid_topic,
          personal_topic: out.personal_topic,

          topic_axis: out.topic_axis,
          topic_category: out.topic_category,
          main_topic: out.main_topic,

          primary_tags: out.primary_tags,
          detail_tags: out.detail_tags,
          tags: out.tags,

          debugReason: out.debugReason || null,
          debugRaw: out.debugRaw || null,
        });
      } catch (err) {
        results.push({
          id: memoId,
          top_topic: null,
          mid_topic: null,
          personal_topic: null,
          topic_axis: null,
          topic_category: null,
          main_topic: null,
          primary_tags: [],
          detail_tags: [],
          tags: [],
          debugReason: "UNCAUGHT_ERROR",
          debugRaw: String(err),
        });
      }
    }

    return { results };
  }
);

// ───────────────── 연관율 계산(편집/검색·추천용) ─────────────────
exports.computeRelevance = onCall(
  {
    cors: ALLOWED_ORIGINS,
    timeoutSeconds: 25,
    secrets: [OPENAI_API_KEY],
  },
  async (req) => {
    requireAuth(req);
    try {
      const query = String(req?.data?.query || "").slice(0, 700);
      const memos = Array.isArray(req?.data?.memos) ? req.data.memos : [];
      const baseTags = normArr(req?.data?.tags || []);

      const normalizedMemos = memos.map((m) => {
        const text = String(m?.text || "");
        const tags = normArr(m?.primary_tags || m?.primaryTags || m?.tags);
        const baseScore = jaccard(baseTags, tags); // 0~1
        const title = firstLine(text, 40) || (tags[0] || "메모");
        return { id: m?.id, text, title, tags, baseScore };
      });

      // Tag-only fallback
      if (!query) {
        const items = normalizedMemos
          .map((m) => ({
            id: m.id,
            type: "memo",
            title: m.title,
            relevance: Math.round(Math.max(0, Math.min(1, m.baseScore)) * 100),
            topSentence: firstLine(m.text, 120),
            reason: "태그 유사도 기반 기본 연관율",
          }))
          .sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
        return { items };
      }

      const apiKey = OPENAI_API_KEY.value();
      if (!apiKey) {
        const items = normalizedMemos
          .map((m) => ({
            id: m.id,
            type: "memo",
            title: m.title,
            relevance: Math.round(Math.max(0, Math.min(1, m.baseScore)) * 100),
            topSentence: firstLine(m.text, 120),
            reason: "OPENAI 키 없음: 태그 유사도로만 산정",
          }))
          .sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
        return { items };
      }

      const client = new OpenAI({ apiKey });
      const judge = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "당신은 검색 랭킹 보정기입니다. 사용자 쿼리와 메모를 보고 0~100 정수 점수를 매겨 JSON만 반환하세요. 형식: {\"items\":[{\"id\":\"\",\"score\":0,\"title\":\"\",\"topSentence\":\"\",\"reason\":\"\"}]}",
          },
          {
            role: "user",
            content: JSON.stringify({
              query,
              memos: normalizedMemos.slice(0, 40).map((m) => ({
                id: m.id,
                title: m.title,
                text: firstLine(m.text, 400),
                tags: m.tags,
              })),
            }),
          },
        ],
      });

      let parsed = {};
      try {
        parsed = JSON.parse(judge?.choices?.[0]?.message?.content || "{}");
      } catch {}

      const arr = Array.isArray(parsed?.items) ? parsed.items : [];
      let items = arr.map((item) => {
        const id = String(item?.id || "");
        let score = Number(item?.score);
        if (Number.isNaN(score)) score = 0;
        score = Math.max(0, Math.min(100, Math.round(score)));
        return {
          id,
          type: "memo",
          title: firstLine(String(item?.title || ""), 40),
          score,
          relevance: score,
          topSentence: String(item?.topSentence || item?.snippet || item?.bestSentence || ""),
          reason: String(item?.reason || item?.why || ""),
        };
      });

      if (!items.length) {
        items = normalizedMemos.map((m) => {
          const relevance = Math.round(Math.max(0, Math.min(1, m.baseScore)) * 100);
          return {
            id: m.id,
            type: "memo",
            title: m.title,
            score: relevance,
            relevance,
            topSentence: firstLine(m.text, 120),
            reason: "LLM 결과 없음 → 태그 유사도 기본 연관율",
          };
        });
      }

      items.sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
      return { items };
    } catch (err) {
      // Keep response shape stable
      return { items: [], error: "computeRelevance_failed" };
    }
  }
);

// ───────────────── 문맥 QA(에디터 어시스턴트) ─────────────────
exports.qaWithContext = onCall(
  {
    cors: ALLOWED_ORIGINS,
    timeoutSeconds: 25,
    secrets: [OPENAI_API_KEY],
  },
  async (req) => {
    try {
      requireAuth(req);

      const apiKey = OPENAI_API_KEY.value();
      if (!apiKey) return { answer: "API 키가 없어 답변할 수 없습니다." };

      const payload = {
        question: String(req?.data?.question || "").slice(0, 800),
        document: req?.data?.document || null,
        memos: Array.isArray(req?.data?.memos) ? req.data.memos.slice(0, 30) : [],
      };

      const SYS = `
당신은 사용자의 글쓰기와 인박스 메모를 함께 보고 도와주는 한국어 전담 어시스턴트입니다.
문맥에 근거가 충분하지 않으면 "제공된 자료 안에서는 확실하게 알 수 없다"라고 답하세요.
`.trim();

      // Use plain text output (no response_format to avoid strict schema issues)
      const client = new OpenAI({ apiKey });
      const resp = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.3,
        messages: [
          { role: "system", content: SYS },
          { role: "user", content: JSON.stringify(payload) },
        ],
      });

      const answer = resp?.choices?.[0]?.message?.content?.trim() || "";
      return { answer };
    } catch (err) {
      return { answer: "", error: "qa_failed" };
    }
  }
);

// 프론트 호출명(answerFromKnowledge) 그대로 쓰기 위한 alias
exports.answerFromKnowledge = exports.qaWithContext;

// ───────────────── 홈 상단 섹션 1: 최근 토픽 요약 ─────────────────
exports.getTopicOverview = onCall(
  {
    cors: ALLOWED_ORIGINS,
    timeoutSeconds: 15,
  },
  async (req) => {
    try {
      const uid = requireAuth(req);
      const limit = Math.min(Math.max(Number(req?.data?.limit) || 200, 20), 500);

      const snap = await db
        .collection("users")
        .doc(uid)
        .collection("memos")
        .orderBy("createdAt", "desc")
        .limit(limit)
        .get();

      const axesMap = new Map(); // axis -> {count, categories: Map, sampleMemoIds:Set}
      const catMap = new Map(); // category -> count
      const primMap = new Map(); // tag -> count

      snap.forEach((doc) => {
        const m = doc.data() || {};

        // IMPORTANT: your app stores camelCase (mainTopic, primaryTags, detailTags)
        const axis = String(m?.topTopic || m?.top_topic || m?.topic_axis || m?.mainTopic || m?.main_topic || "").trim();
        const category = String(m?.midTopic || m?.mid_topic || m?.topic_category || m?.mainTopic || "").trim();
        const primary = normArr(m?.primary_tags || m?.primaryTags || m?.tags);

        if (axis) {
          if (!axesMap.has(axis)) {
            axesMap.set(axis, { count: 0, categories: new Map(), sampleMemoIds: new Set() });
          }
          const entry = axesMap.get(axis);
          entry.count += 1;
          entry.sampleMemoIds.add(doc.id);
          if (category) {
            const cm = entry.categories;
            cm.set(category, (cm.get(category) || 0) + 1);
            catMap.set(category, (catMap.get(category) || 0) + 1);
          }
        }
        primary.forEach((t) => primMap.set(t, (primMap.get(t) || 0) + 1));
      });

      const axes = Array.from(axesMap.entries())
        .map(([axis, v]) => ({
          axis,
          count: v.count,
          categories: Array.from(v.categories.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([category, count]) => ({ category, count })),
          sampleMemoIds: Array.from(v.sampleMemoIds).slice(0, 5),
        }))
        .sort((a, b) => b.count - a.count);

      const topCategories = Array.from(catMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([category, count]) => ({ category, count }));

      const topPrimaryTags = Array.from(primMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([tag, count]) => ({ tag, count }));

      return { axes, topCategories, topPrimaryTags };
    } catch (err) {
      if (String(err).includes("unauthenticated")) return { error: "UNAUTHENTICATED" };
      return { axes: [], topCategories: [], topPrimaryTags: [] };
    }
  }
);

// ───────────────── 리콜(유사 메모 추천) ─────────────────
exports.recallMemosBySeed = onCall(
  {
    cors: ALLOWED_ORIGINS,
    timeoutSeconds: 25,
    secrets: [OPENAI_API_KEY],
  },
  async (req) => {
    try {
      requireAuth(req);

      const seed = req?.data?.seed || {};
      const useEmbedding = !!req?.data?.useEmbedding;
      const max = Math.min(Math.max(Number(req?.data?.max) || 12, 3), 30);

      const seedText = String(seed?.text || "").slice(0, 800);
      const seedTags = normArr(seed?.tags);

      const snap = await db
        .collection("users")
        .doc(req.auth.uid)
        .collection("memos")
        .orderBy("createdAt", "desc")
        .limit(400)
        .get();

      const base = [];
      snap.forEach((doc) => {
        const m = doc.data() || {};
        const tags = normArr(m?.primary_tags || m?.primaryTags || m?.tags);
        const text = String(m?.text || "");
        const score = seedTags.length ? jaccard(seedTags, tags) : 0;
        base.push({ id: doc.id, text, tags, baseScore: score });
      });

      let ranked = base.map((m) => ({ ...m, score: m.baseScore }));

      if (useEmbedding && seedText) {
        const apiKey = OPENAI_API_KEY.value();
        if (apiKey) {
          try {
            const client = new OpenAI({ apiKey });
            const seedEmb = await client.embeddings.create({
              model: "text-embedding-3-small",
              input: seedText,
            });
            const vSeed = seedEmb?.data?.[0]?.embedding || [];

            const sample = base.slice(0, 200);
            const memoEmbInputs = sample.map(
              (m) => m.text.slice(0, 800) || firstLine(m.text, 200) || (m.tags || []).join(",")
            );

            const memEmb = await client.embeddings.create({
              model: "text-embedding-3-small",
              input: memoEmbInputs,
            });

            function cosine(a, b) {
              let dot = 0,
                na = 0,
                nb = 0;
              for (let i = 0; i < a.length && i < b.length; i++) {
                dot += a[i] * b[i];
                na += a[i] * a[i];
                nb += b[i] * b[i];
              }
              if (!na || !nb) return 0;
              return dot / (Math.sqrt(na) * Math.sqrt(nb));
            }

            const id2embScore = new Map();
            memEmb?.data?.forEach((row, i) => {
              const cos = cosine(vSeed, row?.embedding || []);
              id2embScore.set(sample[i].id, cos);
            });

            ranked = base.map((m) => {
              const e = id2embScore.get(m.id) ?? 0;
              return { ...m, score: m.baseScore * 0.5 + e * 0.5 };
            });
          } catch (e) {
            ranked = base.map((m) => ({ ...m, score: m.baseScore }));
          }
        }
      }

      ranked.sort((a, b) => (b.score || 0) - (a.score || 0));
      const out = ranked.slice(0, max).map((m) => ({
        id: m.id,
        preview: firstLine(m.text, 120),
        score: Math.round((m.score || 0) * 100) / 100,
        tags: (m.tags || []).slice(0, 8),
      }));

      return { items: out };
    } catch (err) {
      if (String(err).includes("unauthenticated")) return { error: "UNAUTHENTICATED", items: [] };
      return { items: [] };
    }
  }
);

// ───────────────── 홈 상단: 최근 인사이트 기반 문서 아이디어/아웃라인 ─────────────────
exports.suggestDocOutlinesFromRecent = onCall(
  {
    cors: ALLOWED_ORIGINS,
    timeoutSeconds: 30,
    secrets: [OPENAI_API_KEY],
  },
  async (req) => {
    try {
      requireAuth(req);

      const limit = Math.min(Math.max(Number(req?.data?.limit) || 200, 50), 500);
      const ideaCount = Math.min(Math.max(Number(req?.data?.ideas) || 3, 1), 5);

      const snap = await db
        .collection("users")
        .doc(req.auth.uid)
        .collection("memos")
        .orderBy("createdAt", "desc")
        .limit(limit)
        .get();

      const pool = [];
      const freqTag = new Map();
      const freqCat = new Map();

      snap.forEach((doc) => {
        const m = doc.data() || {};
        const cat = String(m?.midTopic || m?.mid_topic || m?.topic_category || m?.mainTopic || "").trim();
        const prim = normArr(m?.primary_tags || m?.primaryTags || []);
        const text = String(m?.text || "");

        if (cat) freqCat.set(cat, (freqCat.get(cat) || 0) + 1);
        prim.forEach((t) => freqTag.set(t, (freqTag.get(t) || 0) + 1));

        pool.push({ id: doc.id, cat, prim, text: text.slice(0, 600) });
      });

      const topCats = Array.from(freqCat.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k]) => k);

      const topTags = Array.from(freqTag.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([k]) => k);

      const apiKey = OPENAI_API_KEY.value();
      if (!apiKey) {
        const ideas = topCats.slice(0, ideaCount).map((c, i) => ({
          title: `“${c}” 기반 문서 제안 ${i + 1}`,
          why: "최근 인사이트에서 해당 주제 빈도가 높음",
          outline: ["문제 맥락", "핵심 인사이트", "사례/증거", "제안/액션아이템", "결론"],
          seedMemos: pool.filter((p) => p.cat === c).slice(0, 3).map((p) => p.id),
        }));
        return { ideas };
      }

      const SYS = `
당신은 사용자의 최근 인사이트를 바탕으로 "문서 아이디어와 아웃라인"을 제안하는 한국어 어시스턴트입니다.
반드시 JSON만 출력합니다.
형식: {"ideas":[{"title":"","why":"","outline":[""],"seedMemos":[""]}]}
`.trim();

      const prompt = JSON.stringify({
        topCategories: topCats,
        topPrimaryTags: topTags,
        samples: pool.slice(0, 40).map((p) => ({
          id: p.id,
          category: p.cat,
          tags: p.prim,
          text: firstLine(p.text, 200),
        })),
        wantIdeas: ideaCount,
      });

      const client = new OpenAI({ apiKey });
      const resp = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYS },
          { role: "user", content: prompt },
        ],
      });

      const raw = resp?.choices?.[0]?.message?.content?.trim() || "";
      let parsed = {};
      try {
        parsed = JSON.parse(raw);
      } catch (e) {}

      const ideas = (Array.isArray(parsed?.ideas) ? parsed.ideas : [])
        .slice(0, ideaCount)
        .map((it, i) => ({
          title: String(it?.title || `문서 제안 ${i + 1}`),
          why: String(it?.why || "최근 인사이트에서 빈도가 높은 주제"),
          outline: normArr(it?.outline).slice(0, 10),
          seedMemos: normArr(it?.seedMemos).slice(0, 6),
        }));

      return { ideas };
    } catch (err) {
      if (String(err).includes("unauthenticated")) return { error: "UNAUTHENTICATED", ideas: [] };
      return { ideas: [] };
    }
  }
);
