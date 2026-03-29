// source.config.ts
import { defineDocs, defineConfig } from "fumadocs-mdx/config";
import { visit } from "unist-util-visit";
function remarkMermaid() {
  return (tree) => {
    visit(tree, "code", (node, index, parent) => {
      if (node.lang !== "mermaid" || index === void 0 || !parent) return;
      parent.children[index] = {
        type: "mdxJsxFlowElement",
        name: "MermaidDiagram",
        attributes: [
          {
            type: "mdxJsxAttribute",
            name: "chart",
            value: node.value
          }
        ],
        children: []
      };
    });
  };
}
var docs = defineDocs({
  dir: "content/docs"
});
var source_config_default = defineConfig({
  mdxOptions: {
    remarkPlugins: [remarkMermaid]
  }
});
export {
  source_config_default as default,
  docs
};
