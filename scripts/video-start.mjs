import { runVideoCli } from './video-cli.mjs';
runVideoCli('start').catch(error=>{console.error(`${error.code||'VIDEO_START_FAILED'}: ${error.message}`);process.exitCode=1;});
