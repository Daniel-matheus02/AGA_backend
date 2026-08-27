import { io, Socket } from 'socket.io-client';

type Tokens={accessToken:string;refreshToken:string;expiresIn:number;user:{id:string;role:string;merchantId?:string|null}};
type TokenStore={getRefreshToken():Promise<string|null>;setRefreshToken(token:string|null):Promise<void>};

export class AgaApiClient{
  private accessToken:string|null=null;
  private socket?:Socket;
  constructor(private readonly baseUrl:string,private readonly tokenStore:TokenStore){}

  async login(email:string,password:string,totpCode?:string){
    const tokens=await this.raw<Tokens>('/auth/login',{method:'POST',body:JSON.stringify({email,password,totpCode})},false);
    this.accessToken=tokens.accessToken;await this.tokenStore.setRefreshToken(tokens.refreshToken);return tokens.user;
  }
  async refresh(){
    const refreshToken=await this.tokenStore.getRefreshToken();if(!refreshToken)throw new Error('No refresh token');
    const tokens=await this.raw<Tokens>('/auth/refresh',{method:'POST',body:JSON.stringify({refreshToken})},false);
    this.accessToken=tokens.accessToken;await this.tokenStore.setRefreshToken(tokens.refreshToken);return tokens;
  }
  async logout(){
    const refreshToken=await this.tokenStore.getRefreshToken();if(refreshToken)await this.raw('/auth/logout',{method:'POST',body:JSON.stringify({refreshToken})},false).catch(()=>undefined);
    this.accessToken=null;await this.tokenStore.setRefreshToken(null);this.socket?.disconnect();
  }
  async request<T>(path:string,init:RequestInit={},idempotent=false):Promise<T>{
    if(!this.accessToken)await this.refresh();
    try{return await this.raw<T>(path,init,true,idempotent)}catch(error:any){
      if(error?.status!==401)throw error;await this.refresh();return this.raw<T>(path,init,true,idempotent);
    }
  }
  connectEvents(onEvent:(name:string,event:any)=>void){
    if(!this.accessToken)throw new Error('Login required');
    this.socket=io(`${this.baseUrl.replace(/\/v1\/?$/,'')}/events`,{auth:{token:this.accessToken},transports:['websocket']});
    this.socket.onAny(onEvent);return this.socket;
  }
  createCreditRequest(amountCents:number,dailyInstallments:number){return this.request('/credit/requests',{method:'POST',body:JSON.stringify({amountCents,dailyInstallments})},true)}
  createOrder(productId:string,clientId?:string){return this.request('/marketplace/orders',{method:'POST',body:JSON.stringify({productId,clientId})},true)}
  authorizeOrder(orderId:string){return this.request(`/marketplace/orders/${orderId}/authorize`,{method:'POST'},true)}
  fleet(){return this.request('/tracking/admin/fleet/all')}
  dashboard(){return this.request('/admin/dashboard')}

  private async raw<T=unknown>(path:string,init:RequestInit={},authenticated=true,idempotent=false):Promise<T>{
    const headers=new Headers(init.headers);headers.set('Content-Type','application/json');headers.set('X-Request-Id',crypto.randomUUID());
    if(authenticated&&this.accessToken)headers.set('Authorization',`Bearer ${this.accessToken}`);
    if(idempotent)headers.set('Idempotency-Key',crypto.randomUUID());
    const response=await fetch(`${this.baseUrl}${path}`,{...init,headers});
    const data=await response.json().catch(()=>null);
    if(!response.ok){const error:any=new Error(data?.message??'API error');error.status=response.status;error.data=data;throw error}
    return data as T;
  }
}
