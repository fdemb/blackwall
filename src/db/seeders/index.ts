import { AuthMutations } from "../../features/auth/dal/mutations";

export async function signUpTestUser() {
  return await AuthMutations.signUpEmail({
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

signUpTestUser().then(() => {
  console.log("Signed up test user");
});

// issueFactory(10).then(() => {
//   console.log("Seeded 10 issues");
// });
