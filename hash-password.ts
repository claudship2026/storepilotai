/**
 * Generates the ADMIN_PASSWORD_HASH value for .env.
 *
 *   npm run hash -- "your-password"
 */
import bcrypt from "bcryptjs";

const password = process.argv[2];
if (!password) {
  console.error('Usage: npm run hash -- "your-password"');
  process.exit(1);
}

bcrypt.hash(password, 12).then((hash) => {
  // Next.js expands $VAR inside .env values, so the dollar signs in a bcrypt
  // hash must be escaped. This prints the escaped form ready to paste.
  const escaped = hash.replaceAll("$", "\\$");
  console.log("\nPaste this line into .env exactly as printed:\n");
  console.log(`ADMIN_PASSWORD_HASH="${escaped}"\n`);
});
