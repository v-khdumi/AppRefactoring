import {z} from "zod";

export const capabilityServices=["Azure AI Search","Azure Blob Storage","Azure AI Document Intelligence","Azure Service Bus","Azure SQL Database","Azure Cosmos DB"] as const;
export const capabilityRequestSchema=z.object({
  description:z.string().trim().min(20).max(4000),
  answers:z.record(z.string(),z.string().max(2000)).default({}).refine(value=>Object.keys(value).length<=20,"At most twenty clarification answers are accepted."),
  repository:z.string().max(300).optional(),
});
export const capabilityDesignSchema=z.object({
  status:z.enum(["needs-clarification","ready"]),
  name:z.string().min(2).max(100),
  summary:z.string().min(10).max(4000),
  questions:z.array(z.object({id:z.string().min(1).max(80),question:z.string().min(5).max(500),why:z.string().max(500),options:z.array(z.string().max(200)).max(8).default([]),required:z.boolean().default(true)})).max(6),
  frontend:z.array(z.string().min(1).max(500)).max(8),
  backend:z.array(z.string().min(1).max(500)).max(8),
  data:z.array(z.string().min(1).max(500)).max(8),
  azure:z.array(z.string().min(1).max(500)).max(8),
  services:z.array(z.enum(capabilityServices)).max(6).default([]),
  testing:z.array(z.string().min(1).max(500)).max(8),
  security:z.array(z.string().min(1).max(500)).max(8),
  acceptanceCriteria:z.array(z.string().min(1).max(2000)).max(10),
}).superRefine((design,context)=>{
  if(new Set(design.questions.map(question=>question.id)).size!==design.questions.length)context.addIssue({code:"custom",message:"Clarification question IDs must be unique."});
  if(design.status==="needs-clarification"&&!design.questions.length)context.addIssue({code:"custom",message:"Clarification requires at least one question."});
  if(design.status==="ready")for(const area of ["frontend","backend","data","testing","security","acceptanceCriteria"] as const)if(!design[area].length)context.addIssue({code:"custom",message:`A ready design requires ${area}.`});
});
export const capabilitySnapshotSchema=capabilityDesignSchema.safeExtend({source:z.enum(["foundry","rules","demo"]),warning:z.string().max(2000).optional(),clarifications:capabilityRequestSchema.shape.answers});
export type CapabilityDesign=z.infer<typeof capabilitySnapshotSchema>;
export type CapabilityRequest=z.infer<typeof capabilityRequestSchema>;

export function rulesCapabilityDesign(input:CapabilityRequest){
  if(!["primary-users","data-sources","success"].every(key=>input.answers[key]?.trim())){
    return capabilityDesignSchema.parse({
      status:"needs-clarification",name:"Custom AI capability",summary:input.description,
      questions:[
        {id:"primary-users",question:"Who will use this capability and in which application workflow?",why:"This determines the frontend surface, permissions, and interaction design.",options:["Internal employees","Customers","Operations team","Administrators"],required:true},
        {id:"data-sources",question:"Which approved data sources should the capability use?",why:"Grounding, privacy, and retrieval architecture depend on the source systems.",options:["Application database","Uploaded documents","Enterprise search","External APIs"],required:true},
        {id:"success",question:"What measurable outcome defines success?",why:"The Testing Agent needs objective acceptance criteria.",options:[],required:true},
      ],frontend:[],backend:[],data:[],azure:[],services:[],testing:[],security:[],acceptanceCriteria:[],
    });
  }
  const services= input.answers["data-sources"]==="Enterprise search"?["Azure AI Search"]:input.answers["data-sources"]==="Uploaded documents"?["Azure Blob Storage"]:[];
  return capabilityDesignSchema.parse({
    status:"ready",name:"Custom AI capability",summary:input.description,questions:[],
    frontend:["Expose the requested workflow to the clarified users with their approved permissions.","Include loading, provenance, uncertainty, empty and recoverable error states; support keyboard navigation."],
    backend:["Use an authenticated orchestration API with tenant-level authorization before model calls.","Persist auditable requests, results and feedback without logging credentials."],
    data:["Use only the clarified approved source; define retention, provenance and deletion."],
    azure:["Use configured Foundry inference and operational telemetry. Add only explicitly listed services required by the approved source."],services,
    testing:["Execute application-specific acceptance and authorization checks, including dependency failures and regression coverage."],
    security:["Enforce access trimming, sensitive-data controls and prompt/tool boundaries."],
    acceptanceCriteria:[input.answers.success,"Existing application behavior remains covered by executed baseline and candidate tests.","External-service mocks must be distinguished from actual service integration evidence."],
  });
}
