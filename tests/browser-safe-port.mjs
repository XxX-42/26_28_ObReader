// Chromium blocks several low ports. Windows may allocate them for port 0,
// so bind a high-range loopback port for browser test servers.
export async function listenBrowserSafe(server) {
  for (let attempt=0; ; attempt++) {
    const port=40000+Math.floor(Math.random()*20000);
    try {
      await new Promise((resolve,reject)=>{
        server.once('error',reject);
        server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve()});
      });
      return;
    } catch(error) { if(error.code!=='EADDRINUSE'||attempt>=4)throw error; }
  }
}
