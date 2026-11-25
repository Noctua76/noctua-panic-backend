from pathlib import Path
import base64,hashlib,json
root=Path(__file__).resolve().parents[1]
source=root/'docs/questionnaire/production-readonly-collector.cjs';body=source.read_bytes();digest=hashlib.sha256(body).hexdigest()
template=(root/'docs/questionnaire/owner/Owner-Collector.template.ps1').read_text()
wrapper=template.replace('__PAYLOAD_BASE64__',base64.b64encode(body).decode()).replace('__PAYLOAD_SHA256__',digest)
file=root/'docs/questionnaire/owner/AEGIS-Production-Readonly-v3.ps1';file.write_bytes(wrapper.encode('ascii'))
record={'collectorSha256':digest,'procedureSha256':hashlib.sha256(file.read_bytes()).hexdigest(),'collectorVersion':2,'launcherVersion':3,'productionMutationsAllowed':False,'projectId':'0233d8e5-8437-4d94-ad0c-3f24deb1902e','environmentId':'aa887588-a793-47b7-b789-df297f78ef8d','serviceId':'75a4edb0-86fb-4fb6-b7d7-3f88880503ec'}
(root/'docs/questionnaire/owner/COLLECTOR-BINDING.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record))
