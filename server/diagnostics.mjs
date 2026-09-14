import { statfsSync } from 'node:fs';

// Measure the filesystem containing the persistent data, not the container image layer.
export function diskUsage(dataDir) {
  const disk=statfsSync(dataDir,{bigint:true});
  const total=disk.blocks*disk.bsize,free=disk.bfree*disk.bsize,available=disk.bavail*disk.bsize;
  if(total<=0n)throw Error('disk_stats_unavailable');
  const availablePercent=Number(available*10000n/total)/100;
  return {totalBytes:String(total),usedBytes:String(total-free),availableBytes:String(available),
    availablePercent,level:availablePercent<=5?'critical':availablePercent<=15?'warning':'ok',checkedAt:new Date().toISOString()};
}
