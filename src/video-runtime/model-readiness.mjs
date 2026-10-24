/** Read configured model truth from the current authenticated native process. This performs no provider call. */
export async function readNativeModelReadiness(query) {
  const [textResult,mediaResult]=await Promise.allSettled([Promise.resolve().then(()=>query('onboarding.status')),Promise.resolve().then(()=>query('video.gen.catalog',{includeUnavailable:true,limit:200}))]);
  const missing=[];
  const text={configured:false,currentProcessProbeVerified:false};
  const video={configured:false,availableModels:0},image={configured:false,availableModels:0};
  if(textResult.status==='fulfilled'&&textResult.value?.llm&&typeof textResult.value.llm.real==='boolean'){
    const actual=textResult.value;text.configured=actual.llm.real===true&&typeof actual.llm.model==='string'&&actual.llm.model.trim().length>0;
    text.currentProcessProbeVerified=text.configured&&Array.isArray(actual.activationGate?.checks)&&actual.activationGate.checks.some(check=>check?.key==='llm'&&check.ok===true);
    if(!text.configured)missing.push('native-text-model-not-configured');
  }else missing.push('native-text-model-status-unavailable');
  if(mediaResult.status==='fulfilled'&&Array.isArray(mediaResult.value?.models)){
    const available=mediaResult.value.models.filter(model=>model&&model.available===true&&model.availability==='wired');
    video.availableModels=available.filter(model=>model.kind==='video'&&Array.isArray(model.modes)&&model.modes.some(mode=>['t2v','i2v','r2v','v2v','lipsync'].includes(mode))).length;
    image.availableModels=available.filter(model=>model.kind==='image').length;
    video.configured=video.availableModels>0;image.configured=image.availableModels>0;
    if(!video.configured)missing.push('native-video-generation-model-not-configured');
    if(!image.configured)missing.push('native-image-generation-model-not-configured');
  }else missing.push('native-media-model-status-unavailable');
  return {source:'current-authenticated-native-rpc',observedAt:new Date().toISOString(),text,video,image,missing};
}
