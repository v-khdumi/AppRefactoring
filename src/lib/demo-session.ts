import type { NextResponse } from "next/server";

const cookieName="modernize-demo-session";

export function hasDemoSession(request:Request){const cookies=request.headers.get("cookie")||"";return cookies.split(";").some(cookie=>cookie.trim()===`${cookieName}=enabled`);}

export function isDemoRequest(request:Request){
  if(request.headers.get("x-modernize-demo")!=="true")return false;
  return hasDemoSession(request);
}

export function setDemoSession(response:NextResponse){
  response.cookies.set(cookieName,"enabled",{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"strict",path:"/",maxAge:60*60*4});
  return response;
}

export function clearDemoSession(response:NextResponse){
  response.cookies.set(cookieName,"",{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"strict",path:"/",maxAge:0});
  return response;
}
