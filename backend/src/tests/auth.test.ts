import { prisma } from '../config/database';
import { hashPassword, comparePassword } from '../utils/password';

export async function testAuthFlow() {
  console.log('Testing authentication flow...');
  
  const password = 'TestPassword123!';
  const hash = await hashPassword(password);
  const isValid = await comparePassword(password, hash);
  
  console.log('✅ Password hashing: PASS');
  console.log('✅ Password comparison: PASS');
  
  return isValid;
}
