import { IsIn, IsString, IsUUID, MinLength } from 'class-validator';
export class CreatePolicyDto{
  @IsUUID() userId:string;
  @IsString() @MinLength(3) provider:string;
  @IsString() @MinLength(5) providerReference:string;
}
export class ChangePolicyStatusDto{@IsIn(['ACTIVE','SUSPENDED','CANCELLED'])status:'ACTIVE'|'SUSPENDED'|'CANCELLED'}
