export const REPAIR_ADDRESSES=[{choice:'1',label:'3445 Kennedy',yardId:1},{choice:'28',label:'2967 Kennedy',yardId:28},{choice:'15',label:'12441 Woodbine',yardId:15},{choice:'26',label:'150 Clark',yardId:26}];
export const OTHER_WOR_VEHICLE={netsuiteId:'109',masterName:'VEH00109'};
/** @param {{data?:{repairType?:string}}} job */
export const isOther=job=>job.data?.repairType==='other';
