export default async function handler(req, res) {
  // CORS 허용
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-app-token');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'POST 요청만 허용됩니다.' } });
  }

  // 공유 비밀값 확인
  const appToken = req.headers['x-app-token'];
  if (!process.env.APP_SHARED_SECRET || appToken !== process.env.APP_SHARED_SECRET) {
    return res.status(401).json({ error: { message: 'unauthorized' } });
  }

  const body = req.body;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({ error: { message: 'messages가 비어 있습니다.' } });
  }

  // 모델·토큰 상한 강제
  const ALLOWED_MODELS = ['claude-sonnet-5', 'claude-sonnet-4-6'];
  const model = ALLOWED_MODELS.includes(body.model) ? body.model : 'claude-sonnet-5';
  const maxTokens = Math.min(Number(body.max_tokens) || 700, 1000);

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: body.messages })
    });
    const text = await upstream.text();
    res.status(upstream.status).setHeader('Content-Type', 'application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: { message: 'Anthropic API 호출 실패: ' + e.message } });
  }
}
