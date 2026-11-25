'use strict';
// Offline release preflight only. This function neither authorizes nor executes a deploy.
function assertReleaseFloor({manifest, source, encryptedEvidencePresent, requiredKeyIds, availableKeyIds}) {
 if (!manifest || manifest.status !== 'REVIEWED_COMPATIBILITY_FLOOR' || !Array.isArray(manifest.allowedBackendTrees)) throw new Error('REVIEWED_FLOOR_MANIFEST_REQUIRED');
 if (!manifest.allowedBackendTrees.includes(source?.tree)) throw new Error('SOURCE_BELOW_APPROVED_COMPATIBILITY_FLOOR');
 if (encryptedEvidencePresent && (manifest.protocolFloor < 2 || !manifest.immutableSnapshots || !manifest.custodyReaders || !manifest.receiptRecovery)) throw new Error('ENCRYPTED_EVIDENCE_REQUIRES_PROTOCOL_2_READERS');
 if (!Array.isArray(requiredKeyIds) || !Array.isArray(availableKeyIds) || requiredKeyIds.some(id=>!availableKeyIds.includes(id))) throw new Error('HISTORICAL_KEY_ACCESS_REQUIRED');
 return {compatible:true,productionAuthorization:false};
}
module.exports={assertReleaseFloor};
