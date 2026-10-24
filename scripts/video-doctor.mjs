import { runVideoCli } from './video-cli.mjs';
runVideoCli('doctor').catch(error=>{console.error(`${error.code||'VIDEO_DOCTOR_FAILED'}: ${error.message}`);process.exitCode=1;});
