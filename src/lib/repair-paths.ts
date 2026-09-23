import {safeSnapshotPath} from "./verification-evidence";
export function allowedRepairPath(path:string){
  return safeSnapshotPath(path)&&(
    ["package.json","package-lock.json","requirements.txt","backend/requirements.txt","backend/api.py","backend/service.py","backend/ui_api.py","ops/cloud/requirements.txt","frontend/package.json","frontend/package-lock.json","frontend/vitest.config.ts","frontend/vite.config.ts","frontend/README.md"].includes(path)
    ||["tests/","services/backend/","backend/tests/","ops/cloud/tests/","frontend/tests/"].some(prefix=>path.startsWith(prefix))
  );
}