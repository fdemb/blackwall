import { signUpEmail } from "@/server/auth/data";
import { issueFactory } from "../fakes/issue.fake";

async function seedUser() {
  return await signUpEmail({
    account: {
      email: "test@example.com",
      name: "Filip",
      password: "password",
    },
    workspace: {
      displayName: "Test Workspace",
      slug: "test-workspace",
    },
  });
}

seedUser().then(() => {
  console.log("Signed up test user");
  issueFactory(100).then(() => {
    console.log("Seeded 100 issues");
  });
});
