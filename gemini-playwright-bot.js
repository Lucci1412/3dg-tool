/**
 * Gemini Web Bot - Local HTTP Server (port 7722) — FIXED VERSION
 * Ket noi ngam vao Edge/Coc Coc (port 9222) qua CDP.
 * Extension gui POST /analyze -> Bot upload anh+prompt sang Gemini Web -> tra JSON.
 * Cach chay: node gemini-playwright-bot.js
 *
 * CAC FIX SO VOI BAN GOC:
 * 1. Trich JSON: lay code block CUOI CUNG (khong phai dau tien) vi Gemini hay
 *    viet nhap/giai thich truoc khi ra ket qua that.
 * 2. Cho phan hoi ON DINH (doc innerText 2 lan cach nhau, giong nhau moi coi
 *    la xong) thay vi chi doi nut Send bat lai - tranh doc luc dang stream chu.
 * 3. Mo CHAT MOI cho moi request thay vi dung chung 1 tab/hoi thoai - tranh
 *    ngu canh phinh to theo thoi gian lam Gemini tra loi cau truc kem dan.
 * 4. VALIDATE ket qua truoc khi tra ve: canh bao/reject neu 1 feature co qua
 *    nhieu diem (dau hieu bi gop nhieu thua vao 1 polygon).
 * 5. Them huong dan "chi tra JSON, khong giai thich gi them" vao dau prompt.
 */

const { chromium } = require('playwright-core');
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CDP_URL       = 'http://127.0.0.1:9222';
const GEMINI_URL    = 'https://gemini.google.com/app/6a6065e89c9bfd82?hl=vi';
const SERVER_PORT   = 7722;
const TEMP_IMG_PATH = path.join(os.tmpdir(), '3dg_ai_crop_temp.jpg');

// Nguong nghi ngo 1 polygon bi "nuot" nhieu thua vao lam 1 (thua ruong that
// thuong chi co 4-8 dinh, hiem khi qua 12).
const MAX_POINTS_PER_FEATURE = 14;
// Neu prompt xin >=8 thua ma tra ve it hon nguong nay -> nghi ngo bi gop.
const MIN_EXPECTED_FEATURES = 5;

let browser = null;

async function connectBrowser() {
    if (browser) {
        try { browser.contexts(); return; } catch (e) { browser = null; }
    }
    console.log('Ket noi CDP port 9222...');
    browser = await chromium.connectOverCDP(CDP_URL);
    console.log('Da ket noi!');
}

// Luon mo TAB/CHAT MOI cho moi request de tranh ngu canh cu lam nhieu ket qua
async function openFreshGeminiPage() {
    await connectBrowser();
    const ctx = browser.contexts()[0];

    const page = await ctx.newPage();
    await page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1800);
    return page;
}

// Doi noi dung phan hoi ON DINH (khong con thay doi giua 2 lan doc)
async function waitForStableResponse(page, { checkIntervalMs = 1200, maxWaitMs = 90000 } = {}) {
    const start = Date.now();
    let prevText = null;

    // Buoc 1: cho nut Send active tro lai (Gemini bat dau tra loi xong ve co ban)
    try {
        await page.waitForFunction(() => {
            const btn = document.querySelector('button[aria-label*="Send"], .send-button, button[data-mat-icon-name="send"]');
            return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
        }, { timeout: maxWaitMs, polling: 1000 });
    } catch (e) {
        console.warn('Timeout cho nut Send, chuyen sang doc noi dung hien co...');
    }

    // Buoc 2: doc lap lai toi khi noi dung khong doi giua 2 lan (tranh doc luc dang stream)
    while (Date.now() - start < maxWaitMs) {
        const responses = await page.$$('model-response, .model-response-text, [data-response-index]');
        if (responses.length === 0) {
            await page.waitForTimeout(checkIntervalMs);
            continue;
        }
        const lastEl = responses[responses.length - 1];
        const text = await lastEl.innerText();

        if (prevText !== null && text === prevText && text.trim().length > 0) {
            return text; // on dinh 2 lan lien tiep -> coi nhu xong
        }
        prevText = text;
        await page.waitForTimeout(checkIntervalMs);
    }

    console.warn('Het thoi gian cho on dinh, dung ket qua cuoi cung doc duoc.');
    return prevText || '';
}

// Trich JSON: lay CODE BLOCK CUOI CUNG (khong phai dau tien)
function extractJsonFromText(rawText) {
    const matches = [...rawText.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)];
    if (matches.length > 0) {
        // Uu tien block CUOI CUNG - thuong la ban hoan chinh sau khi model
        // co the da "nghi/nhap" o block dau.
        const candidate = matches[matches.length - 1][1].trim();
        return candidate;
    }
    // Khong co code fence -> thu parse nguyen van (phong truong hop model
    // tra JSON tho khong boc trong ```)
    return rawText.trim();
}

// Kiem tra chat luong ket qua: phat hien dau hieu bi gop nhieu thua vao 1 feature
function validateFeatures(json, opts = {}) {
    const features = json?.features || (Array.isArray(json) ? json : null);
    if (!Array.isArray(features)) {
        return { ok: false, reason: 'Khong tim thay mang "features" hop le trong JSON.' };
    }
    if (features.length === 0) {
        return { ok: false, reason: 'features rong.' };
    }

    const suspicious = features.filter(f => Array.isArray(f.points) && f.points.length > MAX_POINTS_PER_FEATURE);
    if (suspicious.length > 0) {
        return {
            ok: false,
            reason: `Phat hien ${suspicious.length} feature co qua nhieu diem (>${MAX_POINTS_PER_FEATURE}) ` +
                    `- nghi ngo bi gop nhieu thua vao 1 polygon. So diem: ${suspicious.map(f => f.points.length).join(', ')}`
        };
    }

    if (opts.expectMinFeatures && features.length < MIN_EXPECTED_FEATURES) {
        return {
            ok: false,
            reason: `Chi nhan duoc ${features.length} feature, it hon nguong ky vong (${MIN_EXPECTED_FEATURES}) ` +
                    `- co the Gemini da gop/bo sot thua.`
        };
    }

    return { ok: true, features };
}

async function queryGeminiOnce(imageBase64, promptText) {
    const page = await openFreshGeminiPage();

    try {
        fs.writeFileSync(TEMP_IMG_PATH, Buffer.from(imageBase64, 'base64'));

        console.log('Mo menu dinh kem anh...');
        const uploadToolsBtn = page.locator('button[aria-label*="Nội dung tải lên"], button[aria-label*="Upload"], button[aria-label*="tải lên"]').first();
        if (await uploadToolsBtn.count() > 0) {
            await uploadToolsBtn.click();
            await page.waitForTimeout(400);
        }

        const inputFile = page.locator('input[type="file"]').first();
        await inputFile.setInputFiles(TEMP_IMG_PATH, { timeout: 10000 });
        console.log('Da dinh kem anh!');
        await page.waitForTimeout(2000);

        const textarea = page.locator('div.ql-editor[contenteditable="true"], rich-textarea div[contenteditable="true"], div[role="textbox"]').first();
        await textarea.waitFor({ timeout: 10000 });
        await textarea.click();

        // Them huong dan nghiem ngat o DAU prompt: chi tra JSON, khong giai thich.
        const strictPrefix = 'IMPORTANT: Respond with ONLY the final JSON code block. ' +
            'Do NOT include any draft, explanation, preamble, or text before/after the code block. ' +
            'Do NOT merge multiple parcels into a single feature.\n\n';
        await page.keyboard.insertText(strictPrefix + promptText);
        await page.waitForTimeout(500);

        await page.keyboard.press('Enter');
        console.log('Da gui prompt. Doi Gemini tra loi on dinh...');

        const rawText = await waitForStableResponse(page);
        console.log('Nhan phan hoi (', rawText.length, 'ky tu):', rawText.slice(0, 150));

        const jsonStr = extractJsonFromText(rawText);
        const parsed = JSON.parse(jsonStr);
        return parsed;
    } finally {
        try { fs.unlinkSync(TEMP_IMG_PATH); } catch (_) {}
        try { await page.close(); } catch (_) {} // dong tab/chat sau moi request
    }
}

// Goi Gemini, tu dong RETRY 1 LAN neu ket qua bi nghi ngo gop thua
async function queryGeminiWithValidation(imageBase64, promptText, opts = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const json = await queryGeminiOnce(imageBase64, promptText);
            const check = validateFeatures(json, opts);
            if (check.ok) {
                return { ok: true, features: check.features };
            }
            console.warn(`[Lan ${attempt}] Ket qua bi nghi ngo: ${check.reason}`);
            lastError = check.reason;
            // thu lai voi mot chat moi hoan toan
        } catch (err) {
            console.warn(`[Lan ${attempt}] Loi khi goi Gemini:`, err.message);
            lastError = err.message;
        }
    }

    return { ok: false, error: `Sau 2 lan thu deu khong duoc ket qua hop le. Loi cuoi: ${lastError}` };
}

// HTTP Server
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, msg: 'Gemini Bot dang chay (fixed version)' }));
        return;
    }

    if (req.method === 'POST' && req.url === '/analyze') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', async () => {
            try {
                const { imageBase64, prompt, expectMinFeatures } = JSON.parse(body);
                if (!imageBase64 || !prompt) throw new Error('Thieu imageBase64 hoac prompt');

                const result = await queryGeminiWithValidation(imageBase64, prompt, {
                    expectMinFeatures: !!expectMinFeatures
                });

                if (!result.ok) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: result.error }));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, features: result.features }));
            } catch (err) {
                console.error('Loi:', err.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
        });
        return;
    }

    res.writeHead(404); res.end('Not Found');
});

server.listen(SERVER_PORT, '127.0.0.1', async () => {
    console.log('Gemini Bot Server (fixed): http://127.0.0.1:' + SERVER_PORT);
    console.log('  POST /analyze { imageBase64, prompt, expectMinFeatures? } -> { ok, features }');
    console.log('  GET  /ping -> kiem tra bot song\n');
    try {
        await connectBrowser();
        console.log('San sang! Extension co the goi POST /analyze ngay bay gio.\n');
    } catch (e) {
        console.warn('Chua ket noi duoc trinh duyet:', e.message);
        console.warn('Hay chac trinh duyet mo voi --remote-debugging-port=9222\n');
    }
});
