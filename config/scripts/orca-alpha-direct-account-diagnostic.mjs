import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const require = createRequire(import.meta.url)
const { build } = require('esbuild')
const output = join(root, '.alpha-cert-cache', 'direct-account-diagnostic.cjs')
await build({
  stdin: {
    contents: `import { runCodexAppServerSession } from './src/main/codex/codex-app-server-session';
      runCodexAppServerSession({
        command: process.argv[2],cliPath: process.argv[2],
        args: ['app-server','--stdio','--config=model_provider="openai"'],
        cwd:'C:/oa-run/codex-runtime-home/home',
        env:{...process.env,CODEX_HOME:'C:/oa-run/codex-runtime-home/home'},
        timeoutMs:30000
      },async rpc=>{
        const state=await rpc.request('account/read',{refreshToken:false});
        const effective=await rpc.request('config/read',{includeLayers:false,cwd:'C:/oa-run/codex-runtime-home/home'});
        const models=await rpc.request('model/list',{cursor:null,limit:20});
        console.log(JSON.stringify({accountType:state.account?.type??null,requiresOpenaiAuth:state.requiresOpenaiAuth,provider:effective.config?.model_provider??null,configuredModel:effective.config?.model??null,models:(models.data??[]).map(model=>({id:model.id,model:model.model,isDefault:model.isDefault}))}));
      }).catch(error=>{console.error(error.message);process.exitCode=1});`,
    resolveDir: root,
    sourcefile: 'orca-alpha-account-diagnostic.ts'
  },
  outfile: output, bundle: true, platform: 'node', format: 'cjs', packages: 'external'
})
await import(pathToFileURL(output).href)
