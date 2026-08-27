import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(process.cwd());let count=0,bad=0;
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.name==='node_modules'||entry.name==='dist')continue;const p=path.join(dir,entry.name);if(entry.isDirectory())walk(p);else if(p.endsWith('.ts')){count++;const sf=ts.createSourceFile(p,fs.readFileSync(p,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);for(const d of sf.parseDiagnostics){bad++;console.error(p,ts.flattenDiagnosticMessageText(d.messageText,'\n'));}}}}
walk(root);console.log({files:count,syntaxErrors:bad});process.exitCode=bad?1:0;
