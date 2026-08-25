/**
 * jobs.js — 后台任务管理（DSH job_list/job_output/job_kill 近似）
 * 异步任务生命周期：created → running → done / failed / killed
 * 持久化到 data/jobs/<id>.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const JOBS_DIR = path.join(process.cwd(), 'data', 'jobs');
function ensureDir() { mkdirSync(JOBS_DIR, { recursive: true }); }
function FP(id) { return path.join(JOBS_DIR, id + '.json'); }

function load(id) {
  const p = FP(id);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function save(job) {
  ensureDir();
  writeFileSync(FP(job.id), JSON.stringify(job, null, 2) + '\n', 'utf8');
}

export function listJobs() {
  ensureDir();
  const list = [];
  for (const f of readdirSync(JOBS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const j = load(f.slice(0, -5));
    if (j) list.push({
      id: j.id, title: j.title, type: j.type, status: j.status,
      createdAt: j.createdAt, updatedAt: j.updatedAt, error: j.error || null
    });
  }
  return list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}
export function getJob(id) { return load(id); }

export function createJob({ title, type = 'async', run } = {}) {
  const id = 'job-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const job = {
    id, title: title || '后台任务', type, status: 'created',
    output: '', error: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    _promise: null
  };
  save(job);
  if (typeof run === 'function') {
    job.status = 'running';
    job._promise = (async () => {
      try {
        const result = await run(job);
        job.output = String(result || '');
        job.status = 'done';
      } catch (e) {
        job.error = String(e.message || e);
        job.status = 'failed';
      }
      job.updatedAt = new Date().toISOString();
      save(job);
    })();
    save(job);
  }
  return getJob(job.id);
}

export function killJob(id) {
  const job = getJob(id);
  if (!job) throw new Error('任务不存在: ' + id);
  if (job.status === 'running' || job.status === 'created') {
    job.status = 'killed';
    job.updatedAt = new Date().toISOString();
    save(job);
  }
  return getJob(id);
}
