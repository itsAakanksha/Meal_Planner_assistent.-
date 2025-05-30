import { Request, Response } from 'express';
import { ApiError } from '../utils/error.classes';
import { db } from '../db';
import { recipeEmbeddings, savedRecipes } from '../db/schema';
import { inArray, eq, and } from 'drizzle-orm';
import { searchRecipes, getRecipeInformation, getRecipeInformationBulk } from '../utils/spoonacular.client';
import { generateEmbedding } from '../utils/embedding.generator';
import { findSimilarVectors, storeEmbedding } from '../utils/vectorDb.client';
import { validateRecipeEmbedding } from '../utils/dataValidation';
import { z } from 'zod';

// Validation schema for recipe search parameters
const recipeSearchParamsSchema = z.object({
  query: z.string().optional(),
  diet: z.string().optional(),
  cuisines: z.array(z.string()).optional(),
  excludeIngredients: z.array(z.string()).optional(),
  maxReadyTime: z.string().optional().transform(val => val ? parseInt(val) : undefined),
  minCalories: z.string().optional().transform(val => val ? parseInt(val) : undefined),
  maxCalories: z.string().optional().transform(val => val ? parseInt(val) : undefined),
  minProtein: z.string().optional().transform(val => val ? parseInt(val) : undefined),
  maxProtein: z.string().optional().transform(val => val ? parseInt(val) : undefined),
  minCarbs: z.string().optional().transform(val => val ? parseInt(val) : undefined),
  maxCarbs: z.string().optional().transform(val => val ? parseInt(val) : undefined),
  minFat: z.string().optional().transform(val => val ? parseInt(val) : undefined),
  maxFat: z.string().optional().transform(val => val ? parseInt(val) : undefined),
  number: z.string().optional().transform(val => val ? parseInt(val) : 20) // Default to 20 results
});

// Validation schema for semantic search parameters
const semanticSearchParamsSchema = z.object({
  q: z.string({ required_error: "Search query is required" }),
  number: z.string().optional().transform(val => val ? parseInt(val) : 20) // Default to 20 results
});

export const recipeController = {
  /**
   * Standard recipe search using Spoonacular API
   * Flow 3: Standard Recipe Search
   */
  searchRecipesSpoonacular: async (req: Request, res: Response) => {
    try {
      // Parse and validate query parameters
      const validationResult = recipeSearchParamsSchema.safeParse(req.query);
      if (!validationResult.success) {
        throw new ApiError(`Invalid search parameters: ${validationResult.error.message}`, 400);
      }

      const searchParams = validationResult.data;
      
      // If query parameter is an empty string, set it to undefined
      if (searchParams.query === '') {
        searchParams.query = undefined;
      }

      // Call Spoonacular API to search for recipes
      const recipes = await searchRecipes(searchParams);

      return res.status(200).json({
        success: true,
        recipes,
        total: recipes.length
      });
    } catch (error) {
      console.error('Error searching recipes:', error);
      if (error instanceof ApiError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to search recipes' });
    }
  },

  /**
   * Semantic recipe search using vector embeddings
   * Flow 4: Semantic Recipe Search
   */
  searchRecipesSemantic: async (req: Request, res: Response) => {
    try {
      // Parse and validate query parameters
      const validationResult = semanticSearchParamsSchema.safeParse(req.query);
      if (!validationResult.success) {
        throw new ApiError(`Invalid search parameters: ${validationResult.error.message}`, 400);
      }

      const { q: query, number } = validationResult.data;

      // Generate embedding for the search query
      const queryEmbedding = await generateEmbedding(query);
      if (!queryEmbedding || !queryEmbedding.length) {
        throw new ApiError('Failed to generate embedding for search query', 500);
      }

      // Search vector database for similar recipes
      const topK = number;
      const results = await findSimilarVectors(queryEmbedding, topK);
      
      if (!results || !results.length) {
        return res.status(200).json({
          success: true,
          recipes: [],
          total: 0
        });
      }

      // Extract spoonacular IDs from results
      const spoonacularIds = results.map(result => parseInt(result.id));
      
      // Get full recipe details from Spoonacular API
      const recipes = await getRecipeInformationBulk(spoonacularIds);

      // Add similarity score to each recipe
      const recipesWithScore = recipes.map(recipe => {
        const resultMatch = results.find(r => parseInt(r.id) === recipe.id);
        return {
          ...recipe,
          similarityScore: resultMatch ? resultMatch.score : 0
        };
      });

      // Sort by similarity score (highest first)
      recipesWithScore.sort((a, b) => b.similarityScore - a.similarityScore);

      return res.status(200).json({
        success: true,
        recipes: recipesWithScore,
        total: recipesWithScore.length
      });
    } catch (error) {
      console.error('Error searching recipes semantically:', error);
      if (error instanceof ApiError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to search recipes semantically' });
    }
  },

  /**
   * Enhanced semantic search with natural language understanding
   * This provides more accurate results for natural language queries
   */
  searchRecipesNaturalLanguage: async (req: Request, res: Response) => {
    try {
      // Parse and validate query parameters
      const validationResult = semanticSearchParamsSchema.safeParse(req.query);
      if (!validationResult.success) {
        throw new ApiError(`Invalid search parameters: ${validationResult.error.message}`, 400);
      }

      const { q: query, number } = validationResult.data;

      // Process the natural language query to extract intent and key terms
      // Create an enhanced query that better captures the semantic meaning
      const processedQuery = `Recipe search: ${query}. Find recipes that match this description, including ingredients, cooking methods, dietary restrictions, and cuisine types.`;

      // Generate embedding for the enhanced search query
      const queryEmbedding = await generateEmbedding(processedQuery);
      if (!queryEmbedding || !queryEmbedding.length) {
        throw new ApiError('Failed to generate embedding for search query', 500);
      }

      // Search vector database for similar recipes with higher similarity threshold
      const topK = number;
      const results = await findSimilarVectors(queryEmbedding, topK);
      
      if (!results || !results.length) {
        return res.status(200).json({
          success: true,
          recipes: [],
          total: 0
        });
      }

      // Extract spoonacular IDs from results
      const spoonacularIds = results.map(result => parseInt(result.id));
      
      // Get full recipe details from Spoonacular API
      const recipes = await getRecipeInformationBulk(spoonacularIds);

      // Add similarity score to each recipe
      const recipesWithScore = recipes.map(recipe => {
        const resultMatch = results.find(r => parseInt(r.id) === recipe.id);
        return {
          ...recipe,
          similarityScore: resultMatch ? resultMatch.score : 0
        };
      });

      // Sort by similarity score (highest first)
      recipesWithScore.sort((a, b) => b.similarityScore - a.similarityScore);

      return res.status(200).json({
        success: true,
        recipes: recipesWithScore,
        total: recipesWithScore.length,
        originalQuery: query
      });
    } catch (error) {
      console.error('Error searching recipes with natural language:', error);
      if (error instanceof ApiError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to search recipes with natural language' });
    }
  },

  /**
   * Get recipe details by ID
   */
  getRecipeById: async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const recipeId = parseInt(id);
      
      if (isNaN(recipeId)) {
        throw new ApiError('Invalid recipe ID', 400);
      }

      const bypassCache = req.query.bypassCache === 'true';
      
      // Get recipe details from Spoonacular
      const recipe = await getRecipeInformation(recipeId, bypassCache);
      
      if (!recipe) {
        throw new ApiError('Recipe not found', 404);
      }

      return res.status(200).json({
        success: true,
        recipe
      });
    } catch (error) {
      console.error('Error getting recipe details:', error);
      if (error instanceof ApiError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to get recipe details' });
    }
  },

  /**
   * Get all saved recipes for the current user
   */
  getSavedRecipes: async (req: Request, res: Response) => {
    try {
      if (!req.auth?.internalUserId) {
        throw new ApiError('User ID not found in request', 401);
      }

      const userId = req.auth.internalUserId;

      // Get saved recipe IDs from the database
      const savedRecipeResults = await db
        .select({
          recipeId: savedRecipes.recipeId
        })
        .from(savedRecipes)
        .where(eq(savedRecipes.userId, userId));

      if (!savedRecipeResults.length) {
        return res.status(200).json({
          success: true,
          recipes: [],
          total: 0
        });
      }

      // Extract recipe IDs
      const recipeIds = savedRecipeResults.map(result => result.recipeId);

      // Get recipe details from Spoonacular API
      const recipes = await getRecipeInformationBulk(recipeIds);

      return res.status(200).json({
        success: true,
        recipes,
        total: recipes.length
      });
    } catch (error) {
      console.error('Error getting saved recipes:', error);
      if (error instanceof ApiError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to get saved recipes' });
    }
  },

  /**
   * Save a recipe for the current user
   */
  saveRecipe: async (req: Request, res: Response) => {
    try {
      if (!req.auth?.internalUserId) {
        throw new ApiError('User ID not found in request', 401);
      }

      const userId = req.auth.internalUserId;
      const recipeIdStr = req.body.recipeId || req.query.recipeId;
      
      if (!recipeIdStr) {
        throw new ApiError('Recipe ID is required', 400);
      }

      const recipeId = parseInt(recipeIdStr);
      
      if (isNaN(recipeId)) {
        throw new ApiError('Invalid recipe ID', 400);
      }

      // Check if recipe exists in Spoonacular
      const recipe = await getRecipeInformation(recipeId);
      if (!recipe) {
        throw new ApiError('Recipe not found', 404);
      }

      // Check if already saved
      const existingEntry = await db
        .select()
        .from(savedRecipes)
        .where(
          and(
            eq(savedRecipes.userId, userId),
            eq(savedRecipes.recipeId, recipeId)
          )
        )
        .limit(1);

      if (existingEntry.length > 0) {
        return res.status(200).json({
          success: true,
          message: 'Recipe already saved',
          alreadySaved: true
        });
      }

      // Save the recipe
      console.log(`📝 RecipeController: Attempting to save recipe ID ${recipeId} for user ${userId}`);
      await db.insert(savedRecipes).values({
        userId,
        recipeId,
        savedAt: new Date()
      });
      console.log(`✅ RecipeController: Recipe ${recipeId} successfully saved for user ${userId}`);

      return res.status(201).json({
        success: true,
        message: 'Recipe saved successfully'
      });
    } catch (error) {
      console.error('Error saving recipe:', error);
      if (error instanceof ApiError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to save recipe' });
    }
  },

  /**
   * Unsave/remove a saved recipe for the current user
   */
  unsaveRecipe: async (req: Request, res: Response) => {
    try {
      if (!req.auth?.internalUserId) {
        throw new ApiError('User ID not found in request', 401);
      }

      const userId = req.auth.internalUserId;
      const recipeIdStr = req.body.recipeId || req.query.recipeId;
      
      if (!recipeIdStr) {
        throw new ApiError('Recipe ID is required', 400);
      }

      const recipeId = parseInt(recipeIdStr);
      
      if (isNaN(recipeId)) {
        throw new ApiError('Invalid recipe ID', 400);
      }

      // Check if recipe is saved first
      const savedRecipe = await db
        .select()
        .from(savedRecipes)
        .where(
          and(
            eq(savedRecipes.userId, userId),
            eq(savedRecipes.recipeId, recipeId)
          )
        )
        .limit(1);

      // If recipe is not saved, return 404
      if (savedRecipe.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Recipe not found in saved items'
        });
      }

      // Remove the saved recipe
      await db
        .delete(savedRecipes)
        .where(
          and(
            eq(savedRecipes.userId, userId),
            eq(savedRecipes.recipeId, recipeId)
          )
        );

      return res.status(200).json({
        success: true,
        message: 'Recipe removed from saved items'
      });
    } catch (error) {
      console.error('Error removing saved recipe:', error);
      if (error instanceof ApiError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to remove saved recipe' });
    }
  },

  /**
   * Check if a recipe is saved by the current user
   */
  isRecipeSaved: async (req: Request, res: Response) => {
    try {
      if (!req.auth?.internalUserId) {
        throw new ApiError('User ID not found in request', 401);
      }

      const userId = req.auth.internalUserId;
      const { id } = req.params;
      const recipeId = parseInt(id);
      
      if (isNaN(recipeId)) {
        throw new ApiError('Invalid recipe ID', 400);
      }

      // Check if recipe is saved
      const savedRecipe = await db
        .select()
        .from(savedRecipes)
        .where(
          and(
            eq(savedRecipes.userId, userId),
            eq(savedRecipes.recipeId, recipeId)
          )
        )
        .limit(1);

      return res.status(200).json({
        success: true,
        isSaved: savedRecipe.length > 0
      });
    } catch (error) {
      console.error('Error checking saved recipe status:', error);
      if (error instanceof ApiError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to check recipe saved status' });
    }
  },
  
  /**
   * Generate and store embeddings for a recipe
   * This is used to power semantic search
   */
  generateEmbedding: async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const recipeId = parseInt(id);
      
      if (isNaN(recipeId)) {
        throw new ApiError('Invalid recipe ID', 400);
      }
      
      // Fetch recipe details
      const recipe = await getRecipeInformation(recipeId);
      if (!recipe) {
        throw new ApiError('Recipe not found', 404);
      }
      
      // Create embedding text from recipe information
      const embeddingText = [
        recipe.title,
        recipe.summary,
        recipe.instructions,
        ...(recipe.extendedIngredients?.map(ing => ing.name) || []),
        ...(recipe.dishTypes || []),
        ...(recipe.cuisines || []),
        ...(recipe.diets || []),
      ].filter(Boolean).join(' ');
      
      if (!embeddingText.trim()) {
        throw new ApiError('Insufficient recipe data for embedding', 400);
      }
      
      // Generate embedding vector
      const embedding = await generateEmbedding(embeddingText);
      if (!embedding || !embedding.length) {
        throw new ApiError('Failed to generate embedding', 500);
      }
      
      // Store metadata for the recipe
      const metadata = {
        title: recipe.title,
        imageUrl: recipe.image,
        readyInMinutes: recipe.readyInMinutes,
        servings: recipe.servings,
        diets: recipe.diets,
        cuisines: recipe.cuisines
      };
      
      // Store in the vector database
      await storeEmbedding(recipeId.toString(), embedding, metadata);
      
      // Store mapping in regular database
      await db.insert(recipeEmbeddings)
        .values({
          spoonacularId: recipeId,
          title: recipe.title,
          descriptionSnippet: recipe.summary ? recipe.summary.substring(0, 200) : '',
          createdAt: new Date(),
          updatedAt: new Date()
        })
        .onConflictDoUpdate({
          target: recipeEmbeddings.spoonacularId,
          set: {
            title: recipe.title,
            descriptionSnippet: recipe.summary ? recipe.summary.substring(0, 200) : '',
            updatedAt: new Date()
          }
        });
      
      console.log(`✅ RecipeController: Recipe embedding for ID ${recipeId} successfully stored in database`);
      
      // Validate embedding was stored correctly
      const validationSucceeded = await validateRecipeEmbedding(recipeId, recipe.title);
      
      if (!validationSucceeded) {
        console.warn(`Warning: Recipe embedding validation failed for recipe ${recipeId}`);
      }
      
      return res.status(200).json({
        success: true,
        recipeId,
        message: 'Recipe embedding generated and stored successfully',
        validated: validationSucceeded
      });
    } catch (error) {
      console.error('Error generating recipe embedding:', error);
      if (error instanceof ApiError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to generate recipe embedding' });
    }
  },
  
  /**
   * Validate a recipe embedding
   */
  validateRecipeEmbedding: async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const recipeId = parseInt(id);
      
      if (isNaN(recipeId)) {
        throw new ApiError('Invalid recipe ID', 400);
      }
      
      // Fetch recipe details to get the title
      const recipe = await getRecipeInformation(recipeId);
      if (!recipe) {
        throw new ApiError('Recipe not found', 404);
      }
      
      // Validate the embedding
      const validationSucceeded = await validateRecipeEmbedding(recipeId, recipe.title);
      
      return res.status(200).json({
        success: true,
        recipeId,
        validated: validationSucceeded
      });
    } catch (error) {
      console.error('Error validating recipe embedding:', error);
      if (error instanceof ApiError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to validate recipe embedding' });
    }
  }
};