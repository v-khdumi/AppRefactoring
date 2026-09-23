import { ArrowRight, Box, Cloud, Database, Globe2, PlugZap } from "lucide-react";
import type { ArchitectureNode } from "@/types/modernization";

const icons = { client: Globe2, service: Box, data: Database, integration: PlugZap, cloud: Cloud };

export function ArchitectureMap({ nodes, variant }: { nodes: ArchitectureNode[]; variant: "current" | "target" }) {
  const layers = [
    { label: "EXPERIENCE", nodes: nodes.filter((node) => node.kind === "client") },
    { label: "APPLICATION", nodes: nodes.filter((node) => node.kind === "service" || node.kind === "cloud") },
    { label: "DATA & INTEGRATIONS", nodes: nodes.filter((node) => node.kind === "data" || node.kind === "integration") },
  ].filter((layer) => layer.nodes.length);
  return (
    <div className={`architecture-map ${variant}`}>
      <div className="architecture-flow" aria-label={`${variant} application architecture diagram`}>
        {layers.map((layer, layerIndex) => <div className="architecture-layer-wrap" key={layer.label}>
          <div className="architecture-layer"><span className="layer-label">{layer.label}</span>{layer.nodes.map((node, index) => { const Icon=icons[node.kind]; return <div className="architecture-node" key={node.id} style={{animationDelay:`${(layerIndex*2+index)*70}ms`}}><div className="node-icon"><Icon size={18}/></div><div><strong>{node.label}</strong><span>{node.detail}</span></div></div>; })}</div>
          {layerIndex<layers.length-1&&<div className="architecture-connector" aria-hidden="true"><i/><ArrowRight size={17}/><i/></div>}
        </div>)}
      </div>
      <div className="diagram-legend"><span><i className="sync-dot"/>Synchronous flow</span><span><i className="boundary-dot"/>Modernization boundary</span></div>
    </div>
  );
}