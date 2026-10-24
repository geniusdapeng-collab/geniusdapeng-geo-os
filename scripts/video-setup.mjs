import { runVideoCli } from './video-cli.mjs';
runVideoCli('setup').catch(error=>{console.error(`${error.code||'VIDEO_SETUP_FAILED'}: ${error.message}`);process.exitCode=1;});
