import path from 'node:path';
import { createHmac } from 'node:crypto';
import { SCOPE, textModelReadiness, verifiedPortraitReuseManifest, VideoRuntimeError } from './config.mjs';

/** Release credentials are needed only by the authenticated dependency downloader. */
export function withoutInstallationCredentials(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key])=>!['WORKLOOM_UI_RELEASE_READ_TOKEN','CNB_UI_RELEASE_TOKEN'].includes(key)));
}

export function nativeEnvironment(config, privateState, urls, desktopKey, toolEnvironment = {}) {
    const base = { ...withoutInstallationCredentials(config.env), ...urls,
      NODE_ENV:'production', SERVER_HOST:'127.0.0.1', SERVER_PORT:String(config.ports.backend), WEB_PORT:String(config.ports.web),
      JWT_SECRET:privateState.credentials.jwt, JWT_ISSUER:'pengmanager-video', PII_SALT:privateState.credentials.pii,
      MEDIA_SIGNING_SECRET:privateState.credentials.media, WORKLOOM_RENDER_SIGNING_SECRET:privateState.credentials.render,
      WORKLOOM_DELIVERY_SIGNING_SECRET:createHmac('sha256',privateState.credentials.render).update('pengmanager-video-delivery-signing/v1').digest('base64url'),
      WORKLOOM_RENDER_SIGNING_KEY_ID:`pengmanager-${privateState.instanceId}`, WORKLOOM_AUDIO_STEM_SIGNING_SECRET:privateState.credentials.audio,
      WORKLOOM_DESKTOP_LOGIN_KEY:desktopKey, WORKLOOM_DESKTOP_WORKSPACE:SCOPE.slug, WORKLOOM_DESKTOP_MEMBER:SCOPE.memberNo,
      PENGMANAGER_ENGINE_ROOT:config.engineRoot, PENGMANAGER_VIDEO_DATA_DIR:config.dataRoot, PENGMANAGER_VIDEO_SOURCE_MAIN:config.sourceMain,
      BUNDLES_ROOT:path.join(config.engineRoot,'bundles'), HR_WORK_DIR:path.join(config.dataRoot,'work'), WORKLOOM_MEDIA_DIR:path.join(config.dataRoot,'media'),
      HR_CHARACTER_LIBRARY:path.join(config.engineRoot,'bundles','ai-video','library','characters'), HR_PRODUCT_LIBRARY:path.join(config.engineRoot,'bundles','ai-video','library','products'),
      HR_PORTRAIT_REUSE_MANIFEST:verifiedPortraitReuseManifest(config), WORKLOOM_DELIVERY_DIR:path.join(config.dataRoot,'delivery'),
      WORKLOOM_POST_WORK_DIR:path.join(config.dataRoot,'post'), WORKLOOM_POST_JOBS_DIR:path.join(config.dataRoot,'post','jobs'),
      WORKLOOM_VOICE_STATION_DIR:path.join(config.dataRoot,'tools','voice'), WORKLOOM_COLOR_HOME:path.join(config.dataRoot,'tools','color'),
      WORKLOOM_KEYS_FILE:path.join(config.dataRoot,'process-model-keys-only.env'), WORKLOOM_API:`http://127.0.0.1:${config.ports.backend}`,
      WORKLOOM_SCHEDULER_MS:'0', WORKLOOM_STARTUP_THREAD_RESUME:'0', ARCHIVE_AUTO_RESUME:'0', WORKLOOM_CLOUD_SYNC:'0', WORKLOOM_RENDER_AUTO:'0',
      WORKLOOM_ENV_PERSIST_MODE:'process-only',
      WORKLOOM_DECLARED_SKILLS_REQUIRED:'1',
      WORKLOOM_PRESERVE_SHADOWED_ROLES:'1',
      HR_PRODUCER:'review', HR_PRODUCER_FALLBACK_APPROVE:'0', VM_PRODUCER_RETRY:'0',
      SKILL_DIST_REGISTRY_URL:'', SKILL_DIST_SIGNING_KEY:'', SKILL_OPS_MODE:'client',
      WORKLOOM_POST_ALLOWED_ROOTS:[config.dataRoot,config.engineRoot].join(path.delimiter),
      WORKLOOM_BGM_ALLOWED_ROOTS:[config.dataRoot,config.engineRoot].join(path.delimiter),
      WORKLOOM_SUBTITLE_ALLOWED_ROOTS:[config.dataRoot,config.engineRoot].join(path.delimiter),
      PATH:[path.dirname(config.node),config.env.PATH||''].join(path.delimiter),
      LLM_PROVIDER:textModelReadiness(config.env).provider,
      VOLCENGINE_ARK_API_KEY:String(config.env.VOLCENGINE_ARK_API_KEY||'').trim()||String(config.env.ARK_API_KEY||'').trim(),
    };
    for(const [key,value]of Object.entries(toolEnvironment)){
      if(['WORKLOOM_UI_RELEASE_READ_TOKEN','CNB_UI_RELEASE_TOKEN'].includes(key))throw new VideoRuntimeError('TOOL_ENV_INVALID','Installation release credentials cannot be supplied to the native runtime.');
      if(/^(DATABASE|JWT_|APP_DB_|GATEWAY_DB_|SERVER_|BUNDLES_ROOT$|HR_(?:WORK_DIR|CHARACTER_LIBRARY|PRODUCT_LIBRARY|PORTRAIT_REUSE_MANIFEST)$|WORKLOOM_(?:DESKTOP_|RENDER_|DELIVERY_|AUDIO_STEM_SIGNING_SECRET$|CLOUD_SYNC$|SCHEDULER_MS$|STARTUP_THREAD_RESUME$|ENV_PERSIST_MODE$|DECLARED_SKILLS_REQUIRED$|PRESERVE_SHADOWED_ROLES$)|MEDIA_SIGNING_SECRET$|PII_SALT$|ARCHIVE_AUTO_RESUME$|SKILL_DIST_|LLM_|DEEPSEEK_|VOLCENGINE_|ARK_)/.test(key))throw new VideoRuntimeError('TOOL_ENV_INVALID','Tool setup attempted to replace native identity, database or authorization controls.');
      if(typeof value!=='string')throw new VideoRuntimeError('TOOL_ENV_INVALID','Managed tool environment must contain strings only.');
      base[key]=value;
    }
  return base;
}
