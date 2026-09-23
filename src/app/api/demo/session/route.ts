import { NextResponse } from "next/server";
import { clearDemoSession, hasDemoSession, setDemoSession } from "@/lib/demo-session";

export async function GET(request:Request){return NextResponse.json({active:hasDemoSession(request)},{headers:{"Cache-Control":"no-store"}});}
export async function POST(){return setDemoSession(NextResponse.json({demo:true},{status:201}));}
export async function DELETE(){return clearDemoSession(NextResponse.json({demo:false}));}
