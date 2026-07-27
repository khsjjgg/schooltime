/**
 * 의견 수집 로그 API — "의견 반영해서 생성"에 입력된 문구를 익명으로 모아
 * 나중에 원문 그대로 확인·다운로드할 수 있게 한다.
 * (share.js와 완전히 같은 방식: GitHub 저장소의 data/opinions.json 파일 사용)
 * ------------------------------------------------------------
 * 배포 방법:
 *  1. GitHub → khsjjgg/schooltime → api/log-opinion.js 파일 열어서 이 내용으로 교체 → Commit
 *  2. Vercel → schooltime 프로젝트 → Settings → Environment Variables 에 새로 추가:
 *     - ADMIN_PASSWORD: 관리자(선생님) 본인만 아는 비밀번호 (원문 삭제용, 기존 값들과 다르게 새로 정할 것)
 *     (GITHUB_TOKEN, GITHUB_REPO, APP_SHARED_SECRET은 기존 것 그대로 재사용)
 *  3. Deployments 탭에서 재배포
 * ------------------------------------------------------------
 */

const DATA_PATH = 'data/opinions.json';
const MAX_ENTRIES = 500; // 파일이 무한정 커지지 않도록 최근 500개만 유지

function ghHeaders(token){
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'schooltime-opinion-log',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function readFile(repo, token){
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${DATA_PATH}`, {
    headers: ghHeaders(token)
  });
  if(res.status === 404) return { items: [], sha: null };
  if(!res.ok) throw new Error(`GitHub 읽기 실패 (${res.status})`);
  const json = await res.json();
  const content = Buffer.from(json.content, 'base64').toString('utf-8');
  let items = [];
  try{ items = JSON.parse(content); }catch(e){ items = []; }
  return { items, sha: json.sha };
}

async function writeFile(repo, token, items, sha){
  const content = Buffer.from(JSON.stringify(items, null, 2), 'utf-8').toString('base64');
  const body = { message: '의견 로그 업데이트', content, ...(sha ? { sha } : {}) };
  return fetch(`https://api.github.com/repos/${repo}/contents/${DATA_PATH}`, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-app-token');
  if(req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if(!token || !repo){
    return res.status(500).json({ error: { message: '서버에 GITHUB_TOKEN/GITHUB_REPO 설정이 없습니다.' } });
  }

  const appToken = req.headers['x-app-token'];
  if(!process.env.APP_SHARED_SECRET || appToken !== process.env.APP_SHARED_SECRET){
    return res.status(401).json({ error: { message: 'unauthorized' } });
  }

  if(req.method === 'GET'){
    try{
      const { items } = await readFile(repo, token);
      return res.status(200).json({ items });
    }catch(e){
      return res.status(502).json({ error: { message: e.message } });
    }
  }

  if(req.method === 'POST'){
    const opinion = req.body && req.body.opinion ? String(req.body.opinion).trim() : '';
    if(!opinion) return res.status(200).json({ ok: true, skipped: true }); // 빈 의견은 조용히 무시

    const entry = {
      id: 'op_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      createdAt: new Date().toISOString(),
      context: String(req.body.context || '').slice(0, 100),
      opinion: opinion.slice(0, 500)
    };

    for(let attempt = 0; attempt < 2; attempt++){
      try{
        const { items, sha } = await readFile(repo, token);
        items.push(entry);
        while(items.length > MAX_ENTRIES) items.shift(); // 오래된 것부터 제거
        const putRes = await writeFile(repo, token, items, sha);
        if(putRes.ok) return res.status(200).json({ ok: true });
        if(putRes.status !== 409){
          const t = await putRes.text();
          return res.status(502).json({ error: { message: `GitHub 저장 실패 (${putRes.status}) ${t.slice(0,200)}` } });
        }
      }catch(e){
        return res.status(502).json({ error: { message: e.message } });
      }
    }
    return res.status(502).json({ error: { message: '동시 저장 충돌로 실패했습니다.' } });
  }

  if(req.method === 'DELETE'){
    if(!process.env.ADMIN_PASSWORD){
      return res.status(500).json({ error: { message: '서버에 ADMIN_PASSWORD 설정이 없습니다.' } });
    }
    const providedPassword = (req.body && req.body.password) ? String(req.body.password) : '';
    if(providedPassword !== process.env.ADMIN_PASSWORD){
      return res.status(403).json({ error: { message: '관리자 비밀번호가 일치하지 않습니다.' } });
    }
    const id = (req.query && req.query.id) || '';
    if(!id) return res.status(400).json({ error: { message: '삭제할 id가 없습니다.' } });

    for(let attempt = 0; attempt < 2; attempt++){
      try{
        const { items, sha } = await readFile(repo, token);
        const nextItems = items.filter(it => it.id !== id);
        if(nextItems.length === items.length){
          return res.status(404).json({ error: { message: '해당 id를 찾을 수 없습니다.' } });
        }
        const putRes = await writeFile(repo, token, nextItems, sha);
        if(putRes.ok) return res.status(200).json({ ok: true });
        if(putRes.status !== 409){
          const t = await putRes.text();
          return res.status(502).json({ error: { message: `GitHub 저장 실패 (${putRes.status}) ${t.slice(0,200)}` } });
        }
      }catch(e){
        return res.status(502).json({ error: { message: e.message } });
      }
    }
    return res.status(502).json({ error: { message: '동시 저장 충돌로 실패했습니다.' } });
  }

  return res.status(405).json({ error: { message: 'GET, POST, DELETE만 허용됩니다.' } });
}
