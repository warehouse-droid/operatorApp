import http from 'node:http';
const server=http.createServer((request,response)=>{
  const upstream=http.request({hostname:'mbbs-special-review-runner',port:3000,path:request.url,method:request.method,headers:request.headers}, incoming=>{
    response.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(response);
  });
  upstream.on('error',()=>{response.writeHead(502);response.end('Isolated review app unavailable');});
  request.pipe(upstream);
  response.on('close',()=>upstream.destroy());
});
server.listen(3000,'0.0.0.0');
