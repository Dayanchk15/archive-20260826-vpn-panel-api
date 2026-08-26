import { listUsers, updateUser } from '/app/lib/db-store.js';
import { upsertUserSubscriptionFile } from '/app/lib/user-subscription-file.js';
const users=await listUsers(10000); const updatedAt=new Date().toISOString(); let changed=0;
for(const user of users.filter(u=>u.status!=='disabled')){
 const old=Array.isArray(user.extraSubscriptionLines)?user.extraSubscriptionLines.map(String):[];
 const next=old.filter(x=>!(x.startsWith('ss://')&&x.includes('@193.233.219.173:20')));
 if(JSON.stringify(old)!==JSON.stringify(next)){await updateUser(user.id,{extraSubscriptionLines:next,updatedAt}); await upsertUserSubscriptionFile({...user,extraSubscriptionLines:next,updatedAt}); changed++;}
}
console.log(JSON.stringify({ok:true,updatedUsers:changed},null,2));
