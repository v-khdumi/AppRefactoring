import type { TransformationRun } from "@/types/modernization";

export function createDemoTransformation(): TransformationRun {
  return {
    id: "MOD-1042",
    name: "OrderHub Modernization",
    repository: "contoso/legacy-order-hub",
    branch: "main",
    targetBranch: "modernize/order-service-slice",
    mode: "demo",
    status: "running",
    progress: 68,
    currentStage: "Generate modern implementation",
    stages: [
      { id: "inventory", title: "Repository inventory", detail: "1,248 files classified and dependency graph built", status: "passed", progress: 100, startedAt: "09:12", completedAt: "09:14" },
      { id: "baseline", title: "Behavior baseline", detail: "23 critical flows captured with characterization tests", status: "passed", progress: 100, startedAt: "09:14", completedAt: "09:21" },
      { id: "plan", title: "Transformation plan", detail: "17 file operations approved against policy", status: "passed", progress: 100, startedAt: "09:21", completedAt: "09:24" },
      { id: "generate", title: "Generate modern implementation", detail: "Migrating the Orders vertical slice to .NET 9", status: "running", progress: 72, startedAt: "09:24" },
      { id: "validate", title: "Build and validate", detail: "Compile, security scan, contract and regression tests", status: "queued", progress: 0 },
      { id: "review", title: "Human approval", detail: "Review exact diff before a pull request can be created", status: "queued", progress: 0 },
    ],
    files: [
      {
        path: "src/OrderService/Program.cs", status: "added", area: "backend", additions: 28, deletions: 0,
        rationale: "Creates the isolated Orders API entry point with health checks and OpenTelemetry. Existing routes remain unchanged behind the gateway.",
        before: "",
        after: `using OrderService.Application;\nusing OrderService.Infrastructure;\n\nvar builder = WebApplication.CreateBuilder(args);\nbuilder.Services.AddOrderApplication();\nbuilder.Services.AddOrderInfrastructure(builder.Configuration);\nbuilder.Services.AddHealthChecks();\nbuilder.Services.AddOpenTelemetry();\n\nvar app = builder.Build();\napp.MapHealthChecks(\"/health\");\napp.MapOrderEndpoints();\napp.Run();`,
        validation: ["Build passed", "Health endpoint verified", "No existing route changed"],
      },
      {
        path: "src/OrderService/Endpoints/OrderEndpoints.cs", oldPath: "Web/Orders/OrderEntry.aspx.cs", status: "modified", area: "backend", additions: 46, deletions: 31,
        rationale: "Moves order submission from Web Forms code-behind into a typed endpoint while retaining validation order and error codes.",
        before: `protected void Submit_Click(object sender, EventArgs e)\n{\n    if (string.IsNullOrEmpty(txtCustomer.Text))\n        ShowError(\"CUSTOMER_REQUIRED\");\n    var order = OrderManager.Create(ReadForm());\n    Response.Redirect(\"OrderView.aspx?id=\" + order.Id);\n}`,
        after: `public static IEndpointRouteBuilder MapOrderEndpoints(this IEndpointRouteBuilder app)\n{\n    app.MapPost(\"/api/orders\", async (CreateOrder request, IOrderService orders) =>\n    {\n        var validation = CreateOrderValidator.Validate(request);\n        if (!validation.IsValid)\n            return Results.ValidationProblem(validation.Errors);\n\n        var order = await orders.CreateAsync(request);\n        return Results.Created($\"/api/orders/{order.Id}\", order);\n    });\n    return app;\n}`,
        validation: ["14 characterization tests passed", "Response codes preserved", "Contract snapshot matched"],
      },
      {
        path: "src/OrderService/Application/CreateOrderValidator.cs", status: "added", area: "backend", additions: 34, deletions: 0,
        rationale: "Makes legacy validation rules explicit and independently testable without changing their execution order.",
        before: "",
        after: `internal static class CreateOrderValidator\n{\n    public static ValidationResult Validate(CreateOrder request)\n    {\n        var errors = new Dictionary<string, string[]>();\n        if (string.IsNullOrWhiteSpace(request.CustomerId))\n            errors[\"customerId\"] = [\"CUSTOMER_REQUIRED\"];\n        if (request.Lines.Count == 0)\n            errors[\"lines\"] = [\"ORDER_LINES_REQUIRED\"];\n        return new ValidationResult(errors);\n    }\n}`,
        validation: ["Legacy rule order preserved", "8 unit tests generated"],
      },
      {
        path: "tests/OrderService.ContractTests/CreateOrderTests.cs", status: "added", area: "tests", additions: 89, deletions: 0,
        rationale: "Locks the existing order creation contract before traffic is moved from the monolith.",
        before: "",
        after: `[Fact]\npublic async Task CreateOrder_preserves_legacy_contract()\n{\n    var request = Fixtures.ValidOrder();\n    var response = await client.PostAsJsonAsync(\"/api/orders\", request);\n    response.StatusCode.Should().Be(HttpStatusCode.Created);\n    await Verify(response);\n}`,
        validation: ["Contract snapshot approved", "Runs in CI quality gate"],
      },
      {
        path: ".github/workflows/order-service.yml", status: "added", area: "platform", additions: 52, deletions: 0,
        rationale: "Adds repeatable build, test, dependency scanning and container publishing for the extracted service.",
        before: "",
        after: `name: Order Service\non: [pull_request]\njobs:\n  quality:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-dotnet@v4\n        with:\n          dotnet-version: 9.0.x\n      - run: dotnet build --no-restore\n      - run: dotnet test --no-build\n      - run: dotnet list package --vulnerable`,
        validation: ["Workflow syntax valid", "Least-privilege permissions"],
      },
    ],
  };
}