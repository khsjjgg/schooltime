/**
 * 공유 게시판 API — 별도 데이터베이스 없이, 이미 쓰고 있는 GitHub 저장소의
 * data/shared.json 파일을 저장 공간으로 사용한다.
 * ------------------------------------------------------------
 * 배포 방법:
 *  1. GitHub → khsjjgg/schooltime 저장소 → api/share.js 파일 열어서 이 내용으로 교체 → Commit
 *  2. Vercel → schooltime 프로젝트 → Settings → Environment Variables 확인:
 *     - GITHUB_TOKEN, GITHUB_REPO, APP_SHARED_SECRET: 기존 값 그대로 재사용
 *     - ADMIN_PASSWORD: log-opinion.js와 동일한 값 (관리자만 아는 비밀번호) — 삭제 권한용
 *  3. Deployments 탭에서 재배포
 * ------------------------------------------------------------
 */

const DATA_PATH = 'data/shared.json';

function ghHeaders(token){
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'schooltime-share-board',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function readFile(repo, token){
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${DATA_PATH}`, {
    headers: ghHeaders(token)
  });
  if(res.status === 404){
    return { items: [], sha: null };
  }
  if(!res.ok){
    throw new Error(`GitHub 읽기 실패 (${res.status})`);
  }
  const json = await res.json();
  const content = Buffer.from(json.content, 'base64').toString('utf-8');
  let items = [];
  try{ items = JSON.parse(content); }catch(e){ items = []; }
  return { items, sha: json.sha };
}

async function writeFile(repo, token, items, sha){
  const content = Buffer.from(JSON.stringify(items, null, 2), 'utf-8').toString('base64');
  const body = {
    message: '공유 게시판 업데이트',
    content,
    ...(sha ? { sha } : {})
  };
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${DATA_PATH}`, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res;
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

  if(req.method === 'GET'){
    try{
      const { items } = await readFile(repo, token);
      // 최신순으로 정렬해서 반환
      items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      return res.status(200).json({ items });
    }catch(e){
      return res.status(502).json({ error: { message: e.message } });
    }
  }

  if(req.method === 'POST'){
    const appToken = req.headers['x-app-token'];
    if(!process.env.APP_SHARED_SECRET || appToken !== process.env.APP_SHARED_SECRET){
      return res.status(401).json({ error: { message: 'unauthorized' } });
    }
    const payload = req.body;
    if(!payload || !Array.isArray(payload.units) || !payload.units.length){
      return res.status(400).json({ error: { message: '공유할 내용이 비어 있습니다.' } });
    }
    const entry = {
      id: 'share_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      createdAt: new Date().toISOString(),
      themeSummary: String(payload.themeSummary || '').slice(0, 200),
      unitCount: payload.units.length,
      units: payload.units,
      postedBy: String(payload.postedBy || '').trim().slice(0, 30) || '익명'
    };

    // 동시 저장 충돌(409) 대비 최대 2회 재시도
    for(let attempt = 0; attempt < 2; attempt++){
      try{
        const { items, sha } = await readFile(repo, token);
        items.push(entry);
        const putRes = await writeFile(repo, token, items, sha);
        if(putRes.ok){
          return res.status(200).json({ ok: true, id: entry.id });
        }
        if(putRes.status !== 409){
          const t = await putRes.text();
          return res.status(502).json({ error: { message: `GitHub 저장 실패 (${putRes.status}) ${t.slice(0,200)}` } });
        }
        // 409면 재시도
      }catch(e){
        return res.status(502).json({ error: { message: e.message } });
      }
    }
    return res.status(502).json({ error: { message: '동시 저장 충돌로 실패했습니다. 다시 시도해 주세요.' } });
  }

  if(req.method === 'DELETE'){
    const appToken = req.headers['x-app-token'];
    if(!process.env.APP_SHARED_SECRET || appToken !== process.env.APP_SHARED_SECRET){
      return res.status(401).json({ error: { message: 'unauthorized' } });
    }
    if(!process.env.ADMIN_PASSWORD){
      return res.status(500).json({ error: { message: '서버에 ADMIN_PASSWORD 설정이 없습니다.' } });
    }
    const providedPassword = (req.body && req.body.password) ? String(req.body.password) : '';
    if(providedPassword !== process.env.ADMIN_PASSWORD){
      return res.status(403).json({ error: { message: '관리자 비밀번호가 일치하지 않습니다.' } });
    }
    const id = (req.query && req.query.id) || '';
    if(!id){
      return res.status(400).json({ error: { message: '삭제할 id가 없습니다.' } });
    }

    for(let attempt = 0; attempt < 2; attempt++){
      try{
        const { items, sha } = await readFile(repo, token);
        const nextItems = items.filter(it => it.id !== id);
        if(nextItems.length === items.length){
          return res.status(404).json({ error: { message: '해당 id를 찾을 수 없습니다.' } });
        }
        const putRes = await writeFile(repo, token, nextItems, sha);
        if(putRes.ok){
          return res.status(200).json({ ok: true });
        }
        if(putRes.status !== 409){
          const t = await putRes.text();
          return res.status(502).json({ error: { message: `GitHub 저장 실패 (${putRes.status}) ${t.slice(0,200)}` } });
        }
      }catch(e){
        return res.status(502).json({ error: { message: e.message } });
      }
    }
    return res.status(502).json({ error: { message: '동시 저장 충돌로 실패했습니다. 다시 시도해 주세요.' } });
  }

  return res.status(405).json({ error: { message: 'GET, POST, DELETE만 허용됩니다.' } });
}
