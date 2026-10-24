/** Run only as an owned one-shot child with the embedded engine's tsx loader. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SCOPE, inside, atomicJson, VideoRuntimeError } from './config.mjs';

export async function initializeWorkspace({ engineRoot, dataRoot, sourceMain, env = process.env }) {
  const engine = fs.realpathSync(engineRoot), privateRoot = fs.realpathSync(dataRoot);
  if (!env.DATABASE_URL || !env.DATABASE_APP_URL || !env.DATABASE_GATEWAY_URL) throw new VideoRuntimeError('DATABASE_CONFIG_REQUIRED', 'All native database role connections are required.');
  const require = createRequire(path.join(engine, 'package.json'));
  const { Pool } = require('pg'), YAML = require('yaml');
  const load = relative => import(pathToFileURL(path.join(engine, relative)).href);
  const assembly = await load('packages/base/bundles/assembly.ts');
  const { skillBindingsFor } = await load('scripts/skill-bindings.mts');
  const { loadOfficialSkills } = await load('packages/base/skills/official.ts');
  const { gatewayAppendOnClient } = await load('packages/base/workdata/gateway.ts');
  const { resolveWorkspaceActiveBundle } = await load('apps/server/src/service/active-bundle.ts');
  const { closeAllPools } = await load('packages/db/src/client.ts');
  const root = path.join(engine, 'bundles');
  const primary = 'geo-growth';
  const projection = assembly.loadBundleUiProjection(primary, root);
  const bundleIds = [...new Set([...(projection.sources || []).map(source => source.bundleId), 'video-edit'])];
  const verifiedBundles=bundleIds.map(id=>({id,manifest:assembly.loadVerifiedBundleManifest(id,root)}));
  const officialSkills=loadOfficialSkills(engine);
  const officialNames=new Set();
  for(const asset of officialSkills){
    if(officialNames.has(asset.name)||!asset.body.trim())throw new VideoRuntimeError('OFFICIAL_SKILL_INVALID','Native official skill registry has a duplicate name or empty body.');
    officialNames.add(asset.name);
  }
  const workforcePolicy={preserveShadowedRoles:env.WORKLOOM_PRESERVE_SHADOWED_ROLES==='1',declaredSkillsRequired:env.WORKLOOM_DECLARED_SKILLS_REQUIRED==='1'};
  const bootstrapFingerprint=createHash('sha256').update(JSON.stringify({schemaVersion:'pengmanager.native-bootstrap-assets/v3',sourceMain,scope:SCOPE,workforcePolicy,
    bundles:verifiedBundles.map(({id,manifest})=>({id,version:manifest.version,integrityDigest:manifest.integrity?.digest})),
    officialSkills:officialSkills.map(asset=>({name:asset.name,version:asset.version,suite:asset.suite,bodySha256:createHash('sha256').update(asset.body).digest('hex')})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0),
  })).digest('hex');
  const owner = new Pool({ connectionString: env.DATABASE_URL, max: 3 }), gateway = new Pool({ connectionString: env.DATABASE_GATEWAY_URL, max: 2 });
  const marker = path.join(privateRoot, 'workspace-ready.json');
  try {
    const db = (await owner.query('SELECT current_database() AS name')).rows[0]?.name;
    if (db !== 'workloom') throw new VideoRuntimeError('DATABASE_IDENTITY_MISMATCH', 'The dedicated video database has the wrong database name.');
    const before = (await owner.query('SELECT id,tenant_id FROM workspaces WHERE slug=$1', [SCOPE.slug])).rows[0];
    if (before && (before.id !== SCOPE.workspaceId || before.tenant_id !== SCOPE.tenantId)) throw new VideoRuntimeError('WORKSPACE_SCOPE_CONFLICT', 'PengManager video workspace slug already belongs to another scope.');
    if (fs.existsSync(marker)) {
      const prior = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (prior.sourceMain === sourceMain && prior.workspaceId === SCOPE.workspaceId && prior.bootstrapFingerprint === bootstrapFingerprint) {
        const current = await resolveWorkspaceActiveBundle(SCOPE.workspaceId);
        if (current.state !== 'ready') throw new VideoRuntimeError('ACTIVE_BUNDLE_UNVERIFIED', 'Existing PengManager video bundle no longer verifies; preserve its state for repair.');
        return { ...prior, reused: true };
      }
    }
    const forbidden = [
      '不得把草稿、本地媒体、模拟数据或HTTP成功声称为真实发布。',
      '不得虚构来源、商品参数、人物授权或实际经营指标。',
      '付费生成、外发和声音克隆须按任务授权、预算与原生围栏执行；成功源片不得因美学评分自动重生成。',
      '客户数据与凭据不得外泄；覆盖层只能收紧既有权限和围栏。',
    ];
    const archive = { brand: 'PengManager', enterprise: { name: '鹏经理系统', profile: '李大鹏的个人GEO、内容与视频生产系统。' }, property: { applicable: false, note: '保留完整组合档案契约；未经营酒店，不含酒店样本数据。' }, forbidden, fact_red_lines: forbidden, accounts: [], platforms: [], charter: { version: 2, mode: 'disabled' }, dataMode: 'real', dataBoundary: '真实本地系统元数据；尚无生产项目、外部发布或经营指标。' };
    const client = await owner.connect();
    let installedSkills = 0;
    const compositions = [];
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [SCOPE.tenantId]);
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [SCOPE.workspaceId]);
      await client.query("INSERT INTO tenants(id,name,plan,status) VALUES($1,'鹏经理本地视频租户','pro','active') ON CONFLICT(id) DO NOTHING", [SCOPE.tenantId]);
      await client.query("INSERT INTO workspaces(id,tenant_id,name,slug,industry,stage,night_config,is_example) VALUES($1,$2,'鹏经理完整视频工作台',$3,$4,NULL,$5,false) ON CONFLICT(id) DO NOTHING", [SCOPE.workspaceId,SCOPE.tenantId,SCOPE.slug,primary,JSON.stringify({enabled:false})]);
      await client.query("INSERT INTO members(id,workspace_id,member_no,name,role,status) VALUES($1,$2,$3,'李大鹏','owner','active') ON CONFLICT(id) DO NOTHING", [SCOPE.memberId,SCOPE.workspaceId,SCOPE.memberNo]);
      await client.query('INSERT INTO profiles(workspace_id,tenant_id,industry,archive,forbidden) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id) DO NOTHING', [SCOPE.workspaceId,SCOPE.tenantId,primary,JSON.stringify(archive),JSON.stringify(forbidden)]);
      for (const bundleId of [primary, 'video-edit']) compositions.push(await assembly.provisionComposedWorkforce({ query: (sql, params) => client.query(sql, params) }, SCOPE, bundleId, SCOPE.memberNo, root, { manageTransaction: false }));
      const bundledNames=new Set();
      const installAsset=async({id,bundle,name,version,description,bindings,body})=>{
        if(bindings.length){
          const active=(await client.query("SELECT DISTINCT rule_id FROM fence_rules WHERE (workspace_id=$1 OR workspace_id='*') AND status='active' AND rule_id=ANY($2)",[SCOPE.workspaceId,bindings])).rows.map(row=>row.rule_id);
          if(bindings.some(binding=>!active.includes(binding)))throw new VideoRuntimeError('SKILL_FENCE_MISSING',`Official skill ${name} references a fence that is not active; bootstrap did not install it.`);
        }
        await client.query("INSERT INTO skills(id,level,bundle,name,version,description,fence_bindings,body,desensitized) VALUES($1,'official',$2,$3,$4,$5,$6,$7,false) ON CONFLICT(id) DO UPDATE SET bundle=EXCLUDED.bundle,body=EXCLUDED.body,version=EXCLUDED.version,description=EXCLUDED.description,fence_bindings=EXCLUDED.fence_bindings",[id,bundle,name,version,description,JSON.stringify(bindings),body]);
        await client.query('INSERT INTO skill_installs(skill_id,workspace_id,installed_by,fence_bindings_snapshot,installed_version) SELECT id,$2,$3,fence_bindings,version FROM skills WHERE id=$1 ON CONFLICT(skill_id,workspace_id) DO UPDATE SET installed_version=EXCLUDED.installed_version,fence_bindings_snapshot=EXCLUDED.fence_bindings_snapshot',[id,SCOPE.workspaceId,SCOPE.memberNo]);
        installedSkills++;
      };
      for (const bundleId of bundleIds) {
        const manifest = assembly.loadVerifiedBundleManifest(bundleId, root);
        for (const asset of manifest.workloom.provides.skills) {
          const file = fs.realpathSync(path.resolve(root, bundleId, asset));
          if (!inside(path.join(root, bundleId), file)) throw new VideoRuntimeError('SKILL_PATH_INVALID', 'Verified skill path escaped its bundle.');
          const raw = fs.readFileSync(file,'utf8'), front = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
          const metadata = YAML.parse(front?.[1] || '{}');
          const name = String(metadata.name || path.basename(path.dirname(asset))).trim();
          if (!name) throw new VideoRuntimeError('SKILL_NAME_INVALID','Verified skill has no valid name.');
          if(bundledNames.has(name)||officialNames.has(name))throw new VideoRuntimeError('SKILL_NAME_CONFLICT','Bundled and native official skill names must resolve uniquely.');
          bundledNames.add(name);
          const id = `skill-peng-${bundleId}-${createHash('sha256').update(name).digest('hex').slice(0,24)}`;
          const bindings = skillBindingsFor(bundleId,name) ?? (Array.isArray(metadata.fence_bindings) ? metadata.fence_bindings : []);
          await installAsset({id,bundle:bundleId,name,version:String(metadata.version||manifest.version),description:String(metadata.description||''),bindings,body:(front?.[2]||raw).trim()});
        }
      }
      for(const asset of officialSkills){
        // Same explicit base-official binding as native scripts/seed.ts; other official skills add no invented fence binding.
        await installAsset({id:`skill-${asset.name}`,bundle:null,name:asset.name,version:asset.version,description:asset.description,body:asset.body,bindings:asset.name==='deal-flow'?['G15']:[]});
      }
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    const check = await assembly.computeAssembly(owner,SCOPE,primary,root);
    if (!check.canActivate) throw new VideoRuntimeError('ASSEMBLY_FAILED', `Native complete-bundle checks failed: ${check.checks.filter(item=>!item.ok).map(item=>item.key).join(', ')}.`);
    const active = (await owner.query("SELECT id,bundle_id FROM bundle_installs WHERE workspace_id=$1 AND status='active'",[SCOPE.workspaceId])).rows;
    const installId = 'bi-pengmanager-video-complete';
    if (active.some(row=>row.id !== installId || row.bundle_id !== primary)) throw new VideoRuntimeError('ACTIVE_INSTALL_CONFLICT','An unexpected active bundle installation already exists.');
    const activation = await assembly.activateBundle(owner,gateway,SCOPE,primary,SCOPE.memberNo,root);
    const c = await owner.connect();
    try {
      await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id',$1,true)",[SCOPE.tenantId]); await c.query("SELECT set_config('app.workspace_id',$1,true)",[SCOPE.workspaceId]);
      const agents = (await c.query('SELECT id FROM agents WHERE workspace_id=$1',[SCOPE.workspaceId])).rows.map(row=>row.id);
      const fences = (await c.query("SELECT id FROM fence_rules WHERE workspace_id=$1 AND status='active'",[SCOPE.workspaceId])).rows.map(row=>row.id);
      const skills = (await c.query('SELECT skill_id FROM skill_installs WHERE workspace_id=$1',[SCOPE.workspaceId])).rows.map(row=>row.skill_id);
      await c.query("INSERT INTO bundle_installs(id,workspace_id,bundle_id,assets,status) VALUES($1,$2,$3,$4,'active') ON CONFLICT(id) DO UPDATE SET assets=EXCLUDED.assets",[installId,SCOPE.workspaceId,primary,JSON.stringify({preset_ids:agents,fence_rule_ids:fences,skill_ids:skills,composition:activation.composition,source:'pengmanager-owned-bootstrap',activation_event_id:activation.eventId})]);
      await c.query('UPDATE workspaces SET bundle_id=$2 WHERE id=$1',[SCOPE.workspaceId,primary]);
      await gatewayAppendOnClient(c,{...SCOPE,actor:{id:'pengmanager-bootstrap',type:'system'}},{who:{type:'system',id:'pengmanager-bootstrap'},context:{tenant_id:SCOPE.tenantId,workspace_id:SCOPE.workspaceId,time:new Date().toISOString(),channel:'local'},object:{type:'workspace',id:SCOPE.workspaceId},decision:{action:'workspace.bootstrap',after:{sourceMain,installId,bundleIds,simulatedQueuesCreated:false,productionMediaCreated:false},basis:['本机主理人授权的完整Edit独立系统初始化','原生组合装配校验与激活通过；未导入演示任务、审批、渲染或经营数据']},rule_impact:[]});
      await c.query('COMMIT');
    } catch(error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
    const resolved = await resolveWorkspaceActiveBundle(SCOPE.workspaceId);
    if (resolved.state !== 'ready') throw new VideoRuntimeError('ACTIVE_BUNDLE_UNVERIFIED','Native active-bundle projection did not verify.');
    const counts = (await owner.query('SELECT (SELECT count(*)::int FROM agents WHERE workspace_id=$1) AS roles,(SELECT count(*)::int FROM skill_installs WHERE workspace_id=$1) AS skills,(SELECT count(*)::int FROM triggers WHERE workspace_id=$1) AS triggers,(SELECT count(*)::int FROM render_jobs WHERE workspace_id=$1) AS render_jobs,(SELECT count(*)::int FROM threads WHERE workspace_id=$1) AS threads',[SCOPE.workspaceId])).rows[0];
    if (!before && (counts.triggers || counts.render_jobs || counts.threads)) throw new VideoRuntimeError('INITIAL_QUEUES_NOT_EMPTY','A fresh video workspace unexpectedly contains runnable business queues.');
    const receipt = {schemaVersion:'pengmanager.video-workspace/v3',sourceMain,bootstrapFingerprint,workforcePolicy,...SCOPE,primaryBundle:primary,bundleIds,installedSkills,bundledSkills:installedSkills-officialSkills.length,nativeOfficialSkills:officialSkills.length,compositions,counts,bundleState:resolved.state,createdAt:new Date().toISOString(),mockBusinessData:false};
    atomicJson(marker,receipt); return receipt;
  } finally { await Promise.all([owner.end(),gateway.end(),closeAllPools()]); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  initializeWorkspace({engineRoot:process.env.PENGMANAGER_ENGINE_ROOT,dataRoot:process.env.PENGMANAGER_VIDEO_DATA_DIR,sourceMain:process.env.PENGMANAGER_VIDEO_SOURCE_MAIN})
    .then(receipt=>process.stdout.write(JSON.stringify(receipt)+'\n'))
    .catch(error=>{ console.error(`${error.code || 'VIDEO_BOOTSTRAP_FAILED'}: ${error.message}`); process.exitCode=1; });
}
