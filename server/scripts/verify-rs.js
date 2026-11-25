import mongoose from 'mongoose';

const uri = 'mongodb://127.0.0.1:27018/bookstore';
try {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  const isMaster = await mongoose.connection.db.admin().command({ hello: 1 });
  console.log(JSON.stringify({
    isReplicaSet: !!isMaster.setName,
    setName: isMaster.setName,
    isWritablePrimary: isMaster.isWritablePrimary || isMaster.ismaster,
    primary: isMaster.primary,
    hosts: isMaster.hosts,
    me: isMaster.me
  }, null, 2));
} catch (e) {
  console.error("Error connecting or running command:", e.message);
} finally {
  await mongoose.disconnect();
}
