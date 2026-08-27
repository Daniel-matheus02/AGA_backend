import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';

export class SecureIoAdapter extends IoAdapter {
  constructor(app:INestApplicationContext,private readonly allowedOrigins:string[]){super(app)}
  createIOServer(port:number,options:any={}){
    return super.createIOServer(port,{
      ...options,
      cors:{origin:this.allowedOrigins,credentials:true,methods:['GET','POST']},
      allowRequest:(req:any,callback:(error:string|null,success:boolean)=>void)=>{
        const origin=req.headers.origin;
        callback(null,!origin||this.allowedOrigins.includes(origin));
      },
      maxHttpBufferSize:64*1024,
      pingInterval:25000,
      pingTimeout:20000,
    });
  }
}
