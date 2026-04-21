let cachedAccessToken = "";
let cachedAccessTokenExpiresAt = 0;

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
};

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body, null, 2), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            ...CORS_HEADERS
        }
    });
}

async function getGigaAccessToken(env) {
    const now = Date.now();
    if (cachedAccessToken && now < cachedAccessTokenExpiresAt - 60_000) {
        return cachedAccessToken;
    }

    const oauthResponse = await fetch("https://ngw.devices.sberbank.ru:9443/api/v2/oauth", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "RqUID": crypto.randomUUID(),
            "Authorization": `Basic ${env.GIGACHAT_AUTH_KEY}`
        },
        body: new URLSearchParams({ scope: env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS" }).toString()
    });

    if (!oauthResponse.ok) {
        const details = await oauthResponse.text();
        throw new Error(`OAuth ${oauthResponse.status}: ${details.slice(0, 250)}`);
    }

    const oauthData = await oauthResponse.json();
    const token = String(oauthData?.access_token || "").trim();
    const expiresAt = Number(oauthData?.expires_at || 0);
    if (!token) throw new Error("OAuth не вернул access_token.");

    cachedAccessToken = token;
    cachedAccessTokenExpiresAt = Number.isFinite(expiresAt) && expiresAt > 0
        ? expiresAt
        : now + 25 * 60 * 1000;

    return cachedAccessToken;
}

async function summarizeWithGigaChat(env, title, text) {
    const accessToken = await getGigaAccessToken(env);
    const model = env.GIGACHAT_MODEL || "GigaChat-2-Max";
    const prompt = [
        "Сделай качественный пересказ школьной новости на русском языке.",
        "Требования:",
        "1) 4-6 предложений.",
        "2) Связный и естественный язык, как в новостной заметке.",
        "3) Не добавляй фактов, которых нет в исходном тексте.",
        "4) Без маркированных списков.",
        "",
        `Заголовок: ${title}`,
        "",
        "Текст:",
        text
    ].join("\n");

    const completionResponse = await fetch("https://gigachat.devices.sberbank.ru/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify({
            model,
            temperature: 0.2,
            top_p: 0.95,
            max_tokens: 420,
            messages: [
                {
                    role: "system",
                    content: "Ты редактор новостей. Пиши сжато, точно и грамотно."
                },
                {
                    role: "user",
                    content: prompt
                }
            ]
        })
    });

    if (!completionResponse.ok) {
        const details = await completionResponse.text();
        throw new Error(`Chat ${completionResponse.status}: ${details.slice(0, 250)}`);
    }

    const data = await completionResponse.json();
    const summary = String(
        data?.choices?.[0]?.message?.content
        || data?.choices?.[0]?.message?.text
        || ""
    ).trim();

    if (!summary) throw new Error("GigaChat вернул пустой пересказ.");
    return summary;
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const pathname = url.pathname.replace(/\/+$/, "") || "/";

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        if (request.method === "GET" && pathname === "/health") {
            return jsonResponse({ ok: true, service: "gigachat-summary-worker" });
        }

        const isSummarizePath = pathname === "/api/summarize" || pathname === "/summarize";
        if (request.method !== "POST" || !isSummarizePath) {
            return jsonResponse({ error: "Not found" }, 404);
        }

        try {
            const body = await request.json();
            const title = String(body?.title || "").trim().slice(0, 500);
            const text = String(body?.text || "").trim().slice(0, 14_000);
            if (!text) return jsonResponse({ error: "Пустой текст новости." }, 400);
            if (!env.GIGACHAT_AUTH_KEY) return jsonResponse({ error: "Не задан секрет GIGACHAT_AUTH_KEY." }, 500);

            const summary = await summarizeWithGigaChat(env, title, text);
            return jsonResponse({ summary });
        } catch (error) {
            return jsonResponse({ error: String(error?.message || error) }, 500);
        }
    }
};
